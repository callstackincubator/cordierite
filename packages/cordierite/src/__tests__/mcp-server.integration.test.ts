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

import { decodeBootstrap, type ToolDescriptor } from "@cordierite/shared";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { createMcpServer, type McpServerHandle } from "../mcp/server.js";
import type { ExecFn } from "../cli/open-target.js";
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
  tools: Array<Partial<ToolDescriptor> & { name: string }>,
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

const BUILTIN_TOOL_NAMES = new Set([
  "cordierite_connect",
  "cordierite_wait_for_session",
  "cordierite_events",
  "cordierite_wait_for_event",
]);

/** Every `tools/list` response always includes the two built-in management tools alongside
 * whatever proxied device tools are live; tests that care only about the proxied tools filter
 * them out here rather than repeating the same two names everywhere. */
const withoutBuiltinTools = <T extends { name: string }>(tools: T[]): T[] => {
  return tools.filter((tool) => !BUILTIN_TOOL_NAMES.has(tool.name));
};

/** `xcrun`/`adb` stub reporting an empty machine. `cordierite_connect` auto-detects a delivery
 * target when none is given, so without an injected `exec` these tests would shell out to the real
 * toolchain and behave differently depending on whether the developer running them happens to have
 * a simulator booted. Tests that want a device inject their own. */
const noDevicesExec: ExecFn = async (command) => {
  if (command === "xcrun") {
    return { stdout: JSON.stringify({ devices: {} }), stderr: "" };
  }

  return { stdout: "List of devices attached\n\n", stderr: "" };
};

const createMcpHandle = async (stateDir: string, exec: ExecFn = noDevicesExec): Promise<McpServerHandle> => {
  const handle = await createMcpServer({
    stateDir,
    spawn: failIfCalled,
    scheme: "cordierite",
    exec,
    env: {},
  });
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

  test("a non-object output schema does not break tools/list: both tools list and both stay callable", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [
      {
        name: "get-profile",
        description: "Returns the profile.",
        output_schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        // `z.array(z.string())`: MCP's `Tool.outputSchema.type` is the literal `"object"`, so
        // before issue #26 this single entry made the client reject the whole list.
        name: "list-todos",
        description: "Returns the todos.",
        output_schema: { type: "array", items: { type: "string" } },
      },
      {
        // `z.union([z.object(...), z.object(...)])`: `anyOf` with no root `type`, so MCP rejects
        // it even though every branch — and every result — is an object.
        name: "get-status",
        description: "Returns one of two shapes.",
        output_schema: {
          anyOf: [
            { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
            { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
          ],
        },
      },
    ]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const resultsByTool: Record<string, unknown> = {
      "get-profile": { name: "Ada" },
      "list-todos": ["write tests", "ship it"],
      "get-status": { ok: true },
    };

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        app.socket.send(
          JSON.stringify({
            type: "tool_result",
            session_id: app.sessionId,
            id: msg.id,
            result: resultsByTool[msg.name as string],
          }),
        );
      }
    });

    // The SDK's own `listTools`, so the result goes through `ListToolsResultSchema` *and* caches
    // the output schemas `callTool` below enforces — exactly what a real client does.
    const listed = await client.listTools();
    const proxiedTools = withoutBuiltinTools(listed.tools);
    expect(proxiedTools.map((tool) => tool.name).sort()).toEqual(["get-profile", "get-status", "list-todos"]);

    const objectTool = proxiedTools.find((tool) => tool.name === "get-profile")!;
    const arrayTool = proxiedTools.find((tool) => tool.name === "list-todos")!;
    const unionTool = proxiedTools.find((tool) => tool.name === "get-status")!;
    expect(objectTool.outputSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(arrayTool.outputSchema).toBeUndefined();
    expect(unionTool.outputSchema).toBeUndefined();

    const profile = await client.callTool({ name: "get-profile", arguments: {} });
    expect(profile.isError).not.toBe(true);
    expect(profile.structuredContent).toEqual({ name: "Ada" });

    // The dropped schema means no `structuredContent` is required or expected; the value still
    // reaches the agent as JSON text.
    const todos = await client.callTool({ name: "list-todos", arguments: {} });
    expect(todos.isError).not.toBe(true);
    expect(todos.structuredContent).toBeUndefined();
    expect(todos.content).toEqual([{ type: "text", text: JSON.stringify(["write tests", "ship it"]) }]);

    // A dropped schema never turns a good result into an error: the union tool's result *is* an
    // object, so it still travels as `structuredContent` — the client just has no schema to
    // validate it against, which is allowed.
    const status = await client.callTool({ name: "get-status", arguments: {} });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toEqual({ ok: true });
    expect(status.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }) }]);

    app.socket.close();
  });

  test("an object output schema paired with a non-object result is a tool_output_validation_error, not a client protocol error", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [
      { name: "lies", description: "Claims an object, returns a number.", output_schema: { type: "object" } },
    ]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        app.socket.send(
          JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: 42 }),
        );
      }
    });

    await client.listTools();

    // `callTool` (not raw `request`) so the SDK's "has an output schema but did not return
    // structured content" guard is live: an `isError` result is the one shape it accepts.
    const result = await client.callTool({ name: "lies", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("tool_output_validation_error");
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("a number");

    app.socket.close();
  });

  // The issue's own example of a result that breaks the `structuredContent` contract.
  test("an object output schema paired with a null result is a tool_output_validation_error", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [
      { name: "nullish", description: "Claims an object, returns null.", output_schema: { type: "object" } },
    ]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        app.socket.send(
          JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: null }),
        );
      }
    });

    await client.listTools();
    const result = await client.callTool({ name: "nullish", arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("tool_output_validation_error");
    expect(text).toContain("returned null");
    // Never the raw `typeof` wording: "a object" / "a undefined" would read as a bug in the tool.
    expect(text).not.toContain("a undefined");
    expect(text).not.toContain("a object");

    app.socket.close();
  });

  test("a tool declaring a timeoutMs above the daemon default gets it, over MCP, end to end (issue #25)", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    // 20 s > DEFAULT_CALL_TIMEOUT_MS (10 s): before this fix the descriptor's timeout never left
    // the app, the daemon applied its 10 s default, and the answer below arrived to a call that
    // had already been rejected as `tool_timeout`. The gap between the 11 s reply and this 20 s
    // deadline is headroom for a slow runner, so drift cannot turn this into a real timeout.
    await snapshotTools(daemon, app, [
      { name: "slow-login", timeout_ms: 20_000 },
    ]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    // The deadline is a daemon-side scheduling hint, never part of the MCP tool contract.
    const listed = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema,
    );
    const proxied = withoutBuiltinTools(listed.tools)[0]!;
    expect(proxied.name).toBe("slow-login");
    expect("timeout_ms" in proxied).toBe(false);
    expect("timeoutMs" in proxied).toBe(false);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        setTimeout(() => {
          app.socket.send(
            JSON.stringify({
              type: "tool_result",
              session_id: app.sessionId,
              id: msg.id,
              result: { loggedIn: true },
            }),
          );
        }, 11_000);
      }
    });

    const called = await client.request(
      { method: "tools/call", params: { name: "slow-login", arguments: {} } },
      CallToolResultSchema,
      // Above the MCP server's own derived transport timeout (20 s + 5 s slack) so this client's
      // watchdog can never be what the assertion actually measures.
      { timeout: 35_000 },
    );

    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toEqual({ loggedIn: true });

    app.socket.close();
  }, 45_000);

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
  test("no target and no device available: falls back to a QR, with instructions to show it", async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      sessionId: string;
      deepLink: string;
      qr: string;
      note: string;
      instructions: string;
      delivered?: true;
    };
    expect(data.sessionId).toBeTruthy();
    expect(data.qr.length).toBeGreaterThan(0);
    expect(data.delivered).toBeUndefined();
    expect(data.note).toMatch(/no booted iOS simulator or attached Android device/iu);
    // The agent has to be told to render the QR and ask, or it goes straight to a silent wait.
    expect(data.instructions).toMatch(/show the user the "qr" field/iu);
    expect(data.instructions).toMatch(/cordierite_wait_for_session/u);

    const payload = data.deepLink.split("cordierite=")[1]!;
    const decoded = decodeBootstrap(payload);
    expect(decoded).not.toBeNull();
    expect(decoded!.sessionId).toBe(data.sessionId);
  });

  test("no target but one booted simulator: delivers to it instead of returning a QR", async () => {
    const { stateDir } = await startTestDaemon();

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });

      if (command === "xcrun" && args.includes("--json")) {
        return {
          stdout: JSON.stringify({
            devices: { "iOS 17.0": [{ state: "Booted", udid: "SIM-1", name: "iPhone 15" }] },
          }),
          stderr: "",
        };
      }

      return { stdout: "List of devices attached\n\n", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      delivered?: true;
      autoDetected?: true;
      target?: string;
      device?: string;
      qr?: string;
      note?: string;
    };

    expect(data.delivered).toBe(true);
    expect(data.autoDetected).toBe(true);
    expect(data.target).toBe("ios-sim");
    expect(data.device).toBe("SIM-1");
    // No QR at all on the delivered path: there is nothing for a human to do.
    expect(data.qr).toBeUndefined();
    expect(data.note).toMatch(/iPhone 15 \(SIM-1\)/u);

    expect(calls.some((call) => call.args.includes("openurl") && call.args.includes("SIM-1"))).toBe(true);
  });

  test('target "none" forces the QR path even with a device booted', async () => {
    const { stateDir } = await startTestDaemon();

    const calls: string[] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return {
        stdout: JSON.stringify({
          devices: { "iOS 17.0": [{ state: "Booted", udid: "SIM-1", name: "iPhone 15" }] },
        }),
        stderr: "",
      };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );

    const data = result.structuredContent as { qr?: string; delivered?: true; note?: string };
    expect(data.delivered).toBeUndefined();
    expect(data.qr!.length).toBeGreaterThan(0);
    expect(data.note).toMatch(/target: "none"/u);
    // An explicit opt-out should not even look for devices.
    expect(calls).toEqual([]);
  });

  test("no target and several devices: no arbitrary pick, the note names every candidate", async () => {
    const { stateDir } = await startTestDaemon();

    const exec: ExecFn = async (command) => {
      if (command === "xcrun") {
        return {
          stdout: JSON.stringify({
            devices: {
              "iOS 17.0": [
                { state: "Booted", udid: "SIM-1", name: "iPhone 15" },
                { state: "Booted", udid: "SIM-2", name: "iPad Pro" },
              ],
            },
          }),
          stderr: "",
        };
      }

      return { stdout: "List of devices attached\n\n", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: {} } },
      CallToolResultSchema,
    );

    const data = result.structuredContent as { qr?: string; delivered?: true; note?: string };
    expect(data.delivered).toBeUndefined();
    expect(data.qr!.length).toBeGreaterThan(0);
    expect(data.note).toMatch(/SIM-1/u);
    expect(data.note).toMatch(/SIM-2/u);
  });

  test('"device" without an explicit target is rejected rather than guessed at', async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { device: "SIM-1" } } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/device.{0,4} requires an explicit/u);
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

  test("auto-detected delivery that fails falls back to a QR instead of erroring the call", async () => {
    const { stateDir } = await startTestDaemon();

    // One booted simulator, but `openurl` fails on it — the app simply isn't installed there.
    // Nobody asked for this device, so this must not become the caller's error.
    const exec: ExecFn = async (command, args) => {
      if (command === "xcrun" && args.includes("--json")) {
        return {
          stdout: JSON.stringify({
            devices: { "iOS 17.0": [{ state: "Booted", udid: "SIM-1", name: "iPhone 15" }] },
          }),
          stderr: "",
        };
      }

      if (args.includes("openurl")) {
        throw Object.assign(new Error("Command failed"), { stderr: "no matching URL scheme" });
      }

      return { stdout: "List of devices attached\n\n", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      qr?: string;
      delivered?: true;
      note?: string;
      instructions?: string;
      deepLink: string;
    };

    expect(data.delivered).toBeUndefined();
    expect(data.qr!.length).toBeGreaterThan(0);
    expect(data.instructions).toBeTruthy();
    expect(data.note).toMatch(/no matching URL scheme/u);
    expect(data.note).toMatch(/falling back to a QR/iu);

    // The fallback link has to be a fresh mint: the first one was minted for 127.0.0.1 on the
    // assumption it was going to a local simulator, which is the wrong address for a scanner.
    expect(decodeBootstrap(data.deepLink.split("cordierite=")[1]!)).not.toBeNull();
  });

  test("cordierite_wait_for_session returns immediately for a session claimed before it was called", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    // The claim is already in the past, so no `session_claimed` event will ever arrive on a
    // subscription opened now — only the catch-up describe can resolve this.
    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "cordierite_wait_for_session", arguments: { sessionId: app.sessionId, timeoutMs: 5000 } },
      },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { sessionId: string; claimed: true; alias: string };
    expect(data.sessionId).toBe(app.sessionId);
    expect(data.claimed).toBe(true);
    expect(data.alias).toBe(app.alias);

    app.socket.close();
  }, 10_000);

  test("cordierite_wait_for_session reports a daemon that goes away instead of waiting out its timeout", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const connectResult = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );
    const { sessionId } = connectResult.structuredContent as { sessionId: string };

    // A generous timeout: the point is that the call comes back on the connection dropping, not on
    // the clock. Without an onClose handler this sits silently for the full 30s.
    const waitPromise = client.request(
      {
        method: "tools/call",
        params: { name: "cordierite_wait_for_session", arguments: { sessionId, timeoutMs: 30_000 } },
      },
      CallToolResultSchema,
    );

    // Let the tool's stream actually establish before pulling the daemon out from under it.
    // Without this the shutdown races the stream opening, and a connect that lands after the
    // socket file is gone takes the auto-spawn path instead — a different failure than the one
    // this test is about.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    await daemon.shutdown();

    const waitResult = await waitPromise;
    const message = JSON.stringify(waitResult.content);

    // Asserting the contract, not one exact sentence: a daemon disappearing is caught at whichever
    // stage happens to be in flight — opening the stream, the subscribe, the catch-up describe, or
    // the socket's own close — and which one wins is a platform detail (Linux resets where macOS
    // closes cleanly). Every route has to come back promptly, name the daemon and the session, and
    // not be the timeout path. Reaching this line at all proves promptness: the tool was given
    // 30s and this test would have failed at 10s.
    expect(waitResult.isError).toBe(true);
    expect(message).toMatch(/Cordierite daemon/u);
    expect(message).toContain(sessionId);
    expect(message).not.toMatch(/Timed out/u);
  }, 10_000);
});

describe("mcp: cordierite_events / cordierite_wait_for_event", () => {
  test("cordierite_events drains app_events already emitted, and honors the returned cursor", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const emitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "greeting", payload: { hi: true }, ts: Date.now() }));
    await emitted;

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const first = await client.request(
      { method: "tools/call", params: { name: "cordierite_events", arguments: {} } },
      CallToolResultSchema,
    );
    expect(first.isError).not.toBe(true);
    const firstData = first.structuredContent as { events: Array<{ kind: string; data: { name: string } }>; cursor: number };
    expect(firstData.events.some((event) => event.kind === "app_event" && event.data.name === "greeting")).toBe(true);

    const second = await client.request(
      { method: "tools/call", params: { name: "cordierite_events", arguments: { since: firstData.cursor } } },
      CallToolResultSchema,
    );
    const secondData = second.structuredContent as { events: unknown[] };
    expect(secondData.events).toEqual([]);

    app.socket.close();
  });

  test("cordierite_wait_for_event resolves immediately for an event that already fired before the call", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const emitted = waitForEvent(daemon, "app_event");
    app.socket.send(
      JSON.stringify({ type: "event", session_id: app.sessionId, name: "already-happened", payload: { n: 1 }, ts: Date.now() }),
    );
    await emitted;

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "cordierite_wait_for_event", arguments: { name: "already-happened", timeoutMs: 2000 } },
      },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { name: string; payload: { n: number } };
    expect(data.name).toBe("already-happened");
    expect(data.payload).toEqual({ n: 1 });

    app.socket.close();
  }, 10_000);

  test("cordierite_wait_for_event resolves once a live-only matching event arrives, ignoring non-matching ones", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const waitPromise = client.request(
      {
        method: "tools/call",
        params: { name: "cordierite_wait_for_event", arguments: { name: "target", timeoutMs: 5000 } },
      },
      CallToolResultSchema,
    );

    const otherEmitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "not-it", ts: Date.now() }));
    await otherEmitted;

    const targetEmitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "target", payload: { ok: true }, ts: Date.now() }));
    await targetEmitted;

    const result = await waitPromise;
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { name: string; payload: { ok: boolean } };
    expect(data.name).toBe("target");
    expect(data.payload).toEqual({ ok: true });

    app.socket.close();
  }, 10_000);

  test("cordierite_wait_for_event rejects with tool_timeout when nothing matches in time", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "cordierite_wait_for_event", arguments: { selector: app.alias, name: "never-arrives", timeoutMs: 300 } },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("tool_timeout");

    app.socket.close();
  }, 10_000);

  test("cordierite_wait_for_event's match filters by shallow payload equality", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const waitPromise = client.request(
      {
        method: "tools/call",
        params: { name: "cordierite_wait_for_event", arguments: { name: "screen_changed", match: { screen: "Checkout" }, timeoutMs: 5000 } },
      },
      CallToolResultSchema,
    );

    const nonMatching = waitForEvent(daemon, "app_event");
    app.socket.send(
      JSON.stringify({ type: "event", session_id: app.sessionId, name: "screen_changed", payload: { screen: "Home" }, ts: Date.now() }),
    );
    await nonMatching;

    const matching = waitForEvent(daemon, "app_event");
    app.socket.send(
      JSON.stringify({ type: "event", session_id: app.sessionId, name: "screen_changed", payload: { screen: "Checkout", total: 42 }, ts: Date.now() }),
    );
    await matching;

    const result = await waitPromise;
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { payload: { screen: string; total: number } };
    expect(data.payload).toEqual({ screen: "Checkout", total: 42 });

    app.socket.close();
  }, 10_000);

  test("cordierite_wait_for_event rejects match values that could never match (objects/arrays)", async () => {
    const { stateDir, port, daemon } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "cordierite_wait_for_event", arguments: { name: "x", match: { nested: { a: 1 } } } },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("invalid_request");

    app.socket.close();
  });

  test("cordierite_wait_for_event's since skips an already-retained match and waits for a fresh one", async () => {
    const { daemon, stateDir, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const first = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "ping", payload: { n: 1 }, ts: Date.now() }));
    await first;

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const drained = await client.request(
      { method: "tools/call", params: { name: "cordierite_events", arguments: { selector: app.alias } } },
      CallToolResultSchema,
    );
    const cursor = (drained.structuredContent as { cursor: number }).cursor;

    const waitPromise = client.request(
      {
        method: "tools/call",
        params: { name: "cordierite_wait_for_event", arguments: { name: "ping", since: cursor, timeoutMs: 5000 } },
      },
      CallToolResultSchema,
    );

    // Give the tool a beat to have drained the (empty, since-filtered) backlog and be listening
    // live before the second `ping` — the earlier one, already covered by `since`, must not resolve it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "ping", payload: { n: 2 }, ts: Date.now() }));
    await second;

    const result = await waitPromise;
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { payload: { n: number } };
    expect(data.payload).toEqual({ n: 2 });

    app.socket.close();
  }, 10_000);

  test("cordierite_events rejects a non-integer since/limit and an unknown kind", async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const nonIntegerSince = await client.request(
      { method: "tools/call", params: { name: "cordierite_events", arguments: { since: 1.5 } } },
      CallToolResultSchema,
    );
    expect(nonIntegerSince.isError).toBe(true);
    expect((nonIntegerSince.content as Array<{ text: string }>)[0]!.text).toContain("invalid_request");

    const zeroLimit = await client.request(
      { method: "tools/call", params: { name: "cordierite_events", arguments: { limit: 0 } } },
      CallToolResultSchema,
    );
    expect(zeroLimit.isError).toBe(true);

    const unknownKind = await client.request(
      { method: "tools/call", params: { name: "cordierite_events", arguments: { kinds: ["not_a_real_kind"] } } },
      CallToolResultSchema,
    );
    expect(unknownKind.isError).toBe(true);
  });
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
