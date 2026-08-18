/**
 * The MCP server (ARCHITECTURE.md §9) proxying a real daemon's RPC
 * surface. Drives a real daemon + fake app-client (same harness pattern as
 * `tool-invocation.integration.test.ts`), and drives the MCP server with the SDK's own `Client`
 * (over `InMemoryTransport` for the functional cases, over a real `StdioServerTransport` wired to
 * plain Node streams for the stdout-purity assertion).
 */

import { connect as connectUds, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createServer as createNetServer } from "node:net";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { decodeBootstrap } from "@cordierite/shared";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { createMcpServer, type McpServerHandle } from "../mcp/server.js";
import { writeTestHostKey } from "./fixtures.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];
const mcpHandles: McpServerHandle[] = [];

afterEach(async () => {
  while (mcpHandles.length > 0) {
    await mcpHandles.pop()?.close();
  }

  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (stateDirs.length > 0) {
    await rm(stateDirs.pop()!, { force: true, recursive: true });
  }
});

const failIfCalled = (): never => {
  throw new Error("auto-spawn should never be needed: the test daemon is already running.");
};

const pickFreePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
};

type TestDaemon = {
  daemon: RunningDaemon;
  stateDir: string;
  port: number;
};

const startTestDaemon = async (): Promise<TestDaemon> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-mcp-"));
  stateDirs.push(stateDir);
  await writeTestHostKey(path.join(stateDir, "key.pem"));

  const port = await pickFreePort();
  await writeFile(
    path.join(stateDir, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1", scheme: "cordierite" }),
  );

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);

  return { daemon, stateDir, port };
};

const rpcCall = (socketPath: string, method: string, params?: unknown): Promise<unknown> => {
  return new Promise((resolve, reject) => {
    const socket: Socket = connectUds(socketPath);
    let buffer = "";

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} })}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      socket.destroy();

      const parsed = JSON.parse(line) as { result?: unknown; error?: { message: string; data?: unknown } };

      if (parsed.error) {
        reject(Object.assign(new Error(parsed.error.message), { data: parsed.error.data }));
        return;
      }

      resolve(parsed.result);
    });

    socket.once("error", reject);
  });
};

const waitForEvent = (daemon: RunningDaemon, kind: string): Promise<{ kind: string; sessionId?: string; alias?: string }> => {
  return new Promise((resolve) => {
    const unsubscribe = daemon.eventBus.subscribe((event) => {
      if (event.kind === kind) {
        unsubscribe();
        resolve(event as { kind: string; sessionId?: string; alias?: string });
      }
    });
  });
};

const connectClient = (port: number): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
};

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> => {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
};

type ClaimedApp = {
  socket: WebSocket;
  sessionId: string;
  alias: string;
};

const createLinkAndDecode = async (
  daemon: RunningDaemon,
): Promise<{ sessionId: string; token: string }> => {
  const result = (await rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds: 60 })) as {
    deepLinkPayload: string;
  };
  const decoded = decodeBootstrap(result.deepLinkPayload);
  expect(decoded).not.toBeNull();

  return { sessionId: decoded!.sessionId, token: decoded!.token };
};

const claimApp = async (daemon: RunningDaemon, port: number, deviceModel = "Pixel 8"): Promise<ClaimedApp> => {
  const link = await createLinkAndDecode(daemon);
  const socket = await connectClient(port);

  const claimed = waitForEvent(daemon, "session_claimed");
  socket.send(
    JSON.stringify({
      type: "session_claim",
      protocol_version: 2,
      session_id: link.sessionId,
      token: link.token,
      device_model: deviceModel,
    }),
  );
  const ack = await nextMessage(socket);
  await claimed;

  return { socket, sessionId: link.sessionId, alias: ack.alias as string };
};

const snapshotTools = async (
  daemon: RunningDaemon,
  app: ClaimedApp,
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
): Promise<void> => {
  const toolsChanged = waitForEvent(daemon, "tools_changed");
  app.socket.send(
    JSON.stringify({
      type: "tool_registry_snapshot",
      session_id: app.sessionId,
      tools: tools.map((tool) => ({ description: "A test tool.", ...tool })),
    }),
  );
  await toolsChanged;
};

const BUILTIN_TOOL_NAMES = new Set(["cordierite_connect", "cordierite_wait_for_session"]);

/** Every `tools/list` response always includes the two built-in management tools alongside
 * whatever proxied device tools are live; tests that care only about the proxied tools filter
 * them out here rather than repeating the same two names everywhere. */
const withoutBuiltinTools = <T extends { name: string }>(tools: T[]): T[] => {
  return tools.filter((tool) => !BUILTIN_TOOL_NAMES.has(tool.name));
};

const createMcpHandle = async (stateDir: string): Promise<McpServerHandle> => {
  const handle = await createMcpServer({ stateDir, spawn: failIfCalled, scheme: "cordierite" });
  mcpHandles.push(handle);
  return handle;
};

/** Connects an SDK `Client` to `handle` over an in-process linked transport pair. */
const connectInMemoryClient = async (handle: McpServerHandle): Promise<Client> => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
};

describe("mcp: tools/list and tools/call", () => {
  test("a fake app's registered tools appear in tools/list with schemas and round-trip through tools/call", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [
      {
        name: "echo",
        description: "Echoes its input.",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
      },
    ]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const proxiedTools = withoutBuiltinTools(listed.tools);
    expect(proxiedTools).toHaveLength(1);
    expect(proxiedTools[0]!.name).toBe("echo");
    expect(proxiedTools[0]!.description).toBe("Echoes its input.");
    expect(proxiedTools[0]!.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } } });

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        app.socket.send(
          JSON.stringify({
            type: "tool_result",
            session_id: app.sessionId,
            id: msg.id,
            result: { echoed: (msg.args as Record<string, unknown>).text },
          }),
        );
      }
    });

    const called = await client.request(
      { method: "tools/call", params: { name: "echo", arguments: { text: "hello" } } },
      CallToolResultSchema,
    );

    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toEqual({ echoed: "hello" });

    app.socket.close();
  });

  test("tool_call_progress frames map to MCP progress notifications when the client sends a progressToken", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "slow" }]);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        app.socket.send(
          JSON.stringify({ type: "tool_call_progress", session_id: app.sessionId, id: msg.id, progress: 0.5, message: "halfway" }),
        );
        setTimeout(() => {
          app.socket.send(
            JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: "done" }),
          );
        }, 50);
      }
    });

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const progressUpdates: Array<{ progress: number; message?: string }> = [];

    const called = await client.request(
      { method: "tools/call", params: { name: "slow", arguments: {} } },
      CallToolResultSchema,
      {
        onprogress: (progress) => {
          progressUpdates.push({ progress: progress.progress, message: progress.message });
        },
      },
    );

    expect(called.isError).not.toBe(true);
    expect(progressUpdates).toEqual([{ progress: 0.5, message: "halfway" }]);

    app.socket.close();
  });

  test("an MCP client's notifications/cancelled forwards to the app as tool_cancel (issue #9)", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "slow" }]);

    const receivedByApp: Record<string, unknown>[] = [];
    const gotToolCancel = new Promise<Record<string, unknown>>((resolve) => {
      app.socket.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        receivedByApp.push(msg);
        // Deliberately never reply to tool_call — the point is that cancellation reaches the app
        // while the call is still pending.
        if (msg.type === "tool_cancel") {
          resolve(msg);
        }
      });
    });

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const controller = new AbortController();
    const callPromise = client
      .request(
        { method: "tools/call", params: { name: "slow", arguments: {} } },
        CallToolResultSchema,
        // `onprogress` is what makes the SDK attach a progressToken — required for the server's
        // progress-correlation path (mcp/server.ts's callProxiedTool) to ever learn `callId`.
        { onprogress: () => {}, signal: controller.signal },
      )
      .catch(() => {
        // The SDK rejects the client-side promise locally as soon as it sends the cancellation —
        // that's the SDK's own behavior, not what this test is verifying.
      });

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (receivedByApp.some((msg) => msg.type === "tool_call")) {
          resolve();
        }
      };
      app.socket.on("message", check);
      check();
    });

    controller.abort("user cancelled");

    const cancelMessage = await gotToolCancel;
    expect(cancelMessage).toMatchObject({ type: "tool_cancel", session_id: app.sessionId, reason: "mcp_client_cancelled" });

    const toolCallMessage = receivedByApp.find((msg) => msg.type === "tool_call");
    expect(cancelMessage.id).toBe(toolCallMessage?.id);

    await callPromise;
    app.socket.close();
  });

  test("the generated MCP tool list (built-ins + one proxied tool) matches the locked mapping", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [
      {
        name: "echo",
        description: "Echoes its input.",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
      },
    ]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    // Names only, sorted: full descriptors (incl. built-ins' free-text descriptions) would make this
    // snapshot brittle against unrelated wording tweaks; the shape/schema mapping is what's locked.
    const shapes = listed.tools
      .map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(shapes).toMatchSnapshot();

    app.socket.close();
  });

  test("a tool without an input_schema gets a permissive object schema", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "no-schema" }]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const proxiedTools = withoutBuiltinTools(listed.tools);
    expect(proxiedTools[0]!.inputSchema).toEqual({ type: "object", additionalProperties: true });

    app.socket.close();
  });

  test("annotations map verbatim onto the MCP tool", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    const toolsChanged = waitForEvent(daemon, "tools_changed");
    app.socket.send(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: app.sessionId,
        tools: [
          {
            name: "destructive-tool",
            description: "Deletes things.",
            annotations: { destructiveHint: true, readOnlyHint: false },
          },
        ],
      }),
    );
    await toolsChanged;

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);
    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const proxiedTools = withoutBuiltinTools(listed.tools);

    expect(proxiedTools[0]!.annotations).toEqual({ destructiveHint: true, readOnlyHint: false });

    app.socket.close();
  });

  test("an app tool_error's type and message are preserved in the MCP error content, not thrown as a protocol error", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "boom" }]);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        app.socket.send(
          JSON.stringify({
            type: "tool_error",
            session_id: app.sessionId,
            id: msg.id,
            error: { type: "tool_execution_error", message: "boom failed" },
          }),
        );
      }
    });

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "boom", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("tool_execution_error");
    expect(text).toContain("boom failed");

    app.socket.close();
  });

  test("calling an unregistered tool returns tool_not_found error content", async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "does-not-exist", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("tool_not_found");
  });
});

describe("mcp: namespacing and list_changed", () => {
  test("a single live session exposes tools under their own names; a second flips to <alias>__<name> and fires list_changed", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const appA = await claimApp(daemon, port, "Pixel 8");
    await snapshotTools(daemon, appA, [{ name: "echo" }]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const singleSessionListing = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    expect(withoutBuiltinTools(singleSessionListing.tools).map((tool) => tool.name)).toEqual(["echo"]);

    let listChangedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChangedCount += 1;
    });

    const appB = await claimApp(daemon, port, "iPhone 15");
    await snapshotTools(daemon, appB, [{ name: "echo" }]);

    // The daemon event that flips the namespacing (appB's own tools_changed) has already fired by
    // the time `snapshotTools` resolves; give the MCP server's own event handling a beat to catch up.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(listChangedCount).toBeGreaterThan(0);

    const multiSessionListing = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const names = withoutBuiltinTools(multiSessionListing.tools)
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([`${appA.alias}__echo`, `${appB.alias}__echo`].sort());

    appA.socket.close();
    appB.socket.close();
  });
});

describe("mcp: cordierite_connect / cordierite_wait_for_session", () => {
  test("cordierite_connect (no target) returns a decodable deep link and a QR", async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { sessionId: string; deepLink: string; qr: string };
    expect(data.sessionId).toBeTruthy();
    expect(data.qr.length).toBeGreaterThan(0);

    const payload = data.deepLink.split("cordierite=")[1]!;
    const decoded = decodeBootstrap(payload);
    expect(decoded).not.toBeNull();
    expect(decoded!.sessionId).toBe(data.sessionId);
  });

  test("cordierite_wait_for_session resolves once a fake client claims the minted session", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const connectResult = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: {} } },
      CallToolResultSchema,
    );
    const { sessionId, deepLink } = connectResult.structuredContent as { sessionId: string; deepLink: string };

    const payload = deepLink.split("cordierite=")[1]!;
    const decoded = decodeBootstrap(payload)!;

    const waitPromise = client.request(
      { method: "tools/call", params: { name: "cordierite_wait_for_session", arguments: { sessionId, timeoutMs: 5000 } } },
      CallToolResultSchema,
    );

    const socket = await connectClient(port);
    const claimed = waitForEvent(daemon, "session_claimed");
    socket.send(
      JSON.stringify({
        type: "session_claim",
        protocol_version: 2,
        session_id: decoded.sessionId,
        token: decoded.token,
        device_model: "Pixel 8",
      }),
    );
    await nextMessage(socket);
    await claimed;

    const waitResult = await waitPromise;
    expect(waitResult.isError).not.toBe(true);
    const data = waitResult.structuredContent as { sessionId: string; claimed: true; alias: string };
    expect(data.sessionId).toBe(sessionId);
    expect(data.claimed).toBe(true);
    expect(data.alias.length).toBeGreaterThan(0);

    socket.close();
  }, 10_000);
});

describe("mcp: cordierite://sessions resource", () => {
  test("lists the resource and reads it back as sessions.list JSON", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const listed = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
    expect(listed.resources.map((resource) => resource.uri)).toContain("cordierite://sessions");

    const read = await client.request(
      { method: "resources/read", params: { uri: "cordierite://sessions" } },
      ReadResourceResultSchema,
    );
    const text = (read.contents[0] as { text: string }).text;
    const sessions = JSON.parse(text) as Array<{ alias: string }>;
    expect(sessions.map((session) => session.alias)).toContain(app.alias);

    app.socket.close();
  });
});

describe("mcp: stdout purity", () => {
  test("nothing is ever written to the stdio transport's stream except MCP protocol frames", async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);

    // A real StdioServerTransport wired to plain PassThrough streams (no subprocess): every write
    // captured here is exactly what would have gone to the real process.stdout in production.
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();

    const capturedChunks: string[] = [];
    serverToClient.on("data", (chunk: Buffer) => {
      capturedChunks.push(chunk.toString("utf8"));
    });

    await handle.connect(new StdioServerTransport(clientToServer, serverToClient));

    // A minimal hand-rolled client-side transport speaking the same newline-delimited JSON framing
    // as StdioServerTransport (see `@modelcontextprotocol/sdk/shared/stdio.js`), driving the SDK
    // Client without spawning a subprocess.
    let onmessage: ((message: unknown) => void) | undefined;
    let readBuffer = "";
    serverToClient.on("data", (chunk: Buffer) => {
      readBuffer += chunk.toString("utf8");
      let newlineIndex = readBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = readBuffer.slice(0, newlineIndex);
        readBuffer = readBuffer.slice(newlineIndex + 1);
        newlineIndex = readBuffer.indexOf("\n");
        if (line.length > 0) {
          onmessage?.(JSON.parse(line));
        }
      }
    });

    const clientTransport = {
      start: async () => {},
      send: async (message: unknown) => {
        clientToServer.write(`${JSON.stringify(message)}\n`);
      },
      close: async () => {
        clientToServer.end();
      },
      set onmessage_(_cb: unknown) {},
    };
    Object.defineProperty(clientTransport, "onmessage", {
      set(cb: (message: unknown) => void) {
        onmessage = cb;
      },
      get() {
        return onmessage;
      },
    });

    const client = new Client({ name: "test-stdio-client", version: "0.0.0" });
    await client.connect(clientTransport as never);

    await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);

    expect(capturedChunks.length).toBeGreaterThan(0);

    for (const chunk of capturedChunks) {
      for (const line of chunk.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }

        const parsed = JSON.parse(line) as { jsonrpc?: string };
        expect(parsed.jsonrpc).toBe("2.0");
      }
    }
  });
});
