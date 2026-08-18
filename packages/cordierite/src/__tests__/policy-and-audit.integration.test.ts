/**
 * The daemon policy engine and audit log (ARCHITECTURE.md §12). Same
 * harness pattern as `tool-invocation.integration.test.ts` — a real daemon, a scripted fake
 * app-client over a real pinned `wss://` socket, and raw UDS JSON-RPC — plus a real MCP server
 * (same pattern as `mcp-server.integration.test.ts`) for the `caller` attribution case.
 */

import { connect as connectUds, createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { decodeBootstrap, type EventKind, type EventNotification } from "@cordierite/shared";

import { loadConfig } from "../daemon/config.js";
import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
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

const startTestDaemon = async (configOverrides: Record<string, unknown> = {}): Promise<TestDaemon> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-policy-audit-"));
  stateDirs.push(stateDir);
  await writeTestHostKey(path.join(stateDir, "key.pem"));

  const port = await pickFreePort();
  await writeFile(
    path.join(stateDir, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1", ...configOverrides }),
  );

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);

  return { daemon, stateDir, port };
};

/** Removes `daemon` from the tracked list and shuts it down immediately — used mid-test so a
 * later `afterEach` sweep doesn't double-shutdown (harmless, but this also lets a test assert on
 * the audit file *before* the sweep would otherwise run, guaranteeing the flush has happened). */
const shutdownNow = async (daemon: RunningDaemon): Promise<void> => {
  const index = runningDaemons.indexOf(daemon);

  if (index !== -1) {
    runningDaemons.splice(index, 1);
  }

  await daemon.shutdown();
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

const waitForEvent = (daemon: RunningDaemon, kind: EventKind): Promise<EventNotification> => {
  return new Promise((resolve) => {
    const unsubscribe = daemon.eventBus.subscribe((event) => {
      if (event.kind === kind) {
        unsubscribe();
        resolve(event);
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

const createLinkAndDecode = async (daemon: RunningDaemon): Promise<{ sessionId: string; token: string }> => {
  const result = (await rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds: 60 })) as {
    deepLinkPayload: string;
  };
  const decoded = decodeBootstrap(result.deepLinkPayload);
  expect(decoded).not.toBeNull();

  return { sessionId: decoded!.sessionId, token: decoded!.token };
};

/** Mints a link, claims it over a fresh socket, and returns the claimed app connection. `Pixel 8`
 * always slugifies to the deterministic alias `pixel-8` for the first session claimed with that
 * model (`sessions.ts`'s `slugifyDeviceModel`/`dedupeAlias`) — tests rely on that determinism to
 * pre-configure `policy.tools["pixel-8/<name>"]` overrides before any claim happens. */
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
  tools: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }>,
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

const todayAuditPath = (stateDir: string): string => {
  const paths = getStateDirPaths(stateDir);
  const dateStamp = new Date().toISOString().slice(0, 10);
  return path.join(paths.auditDir, `${dateStamp}.jsonl`);
};

type AuditRecord = {
  ts: string;
  sessionId: string;
  alias: string;
  tool: string;
  argsSha256: string;
  outcome: "ok" | "error" | "denied" | "cancelled";
  errorType?: string;
  durationMs: number;
  caller: "cli" | "mcp";
};

const readAuditRecords = async (stateDir: string): Promise<AuditRecord[]> => {
  const raw = await readFile(todayAuditPath(stateDir), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
};

describe("policy: evaluate", () => {
  test("a destructive-hinted tool is denied under policy.destructive: deny, with no frame reaching the app", async () => {
    const { daemon, port } = await startTestDaemon({ policy: { destructive: "deny" } });
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "deleteAll", annotations: { destructiveHint: true } }]);

    const received: Record<string, unknown>[] = [];
    app.socket.on("message", (data) => {
      received.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    });

    await expect(
      rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "deleteAll", args: {} }),
    ).rejects.toMatchObject({ data: { type: "policy_denied" } });

    expect(received.some((msg) => msg.type === "tool_call")).toBe(false);

    app.socket.close();
  });

  test("a per-tool override beats the destructive category rule (deny-by-default, allow-by-override)", async () => {
    const { daemon, port } = await startTestDaemon({
      policy: { destructive: "deny", tools: { "pixel-8/deleteAll": "allow" } },
    });
    const app = await claimApp(daemon, port, "Pixel 8");
    expect(app.alias).toBe("pixel-8");
    await snapshotTools(daemon, app, [{ name: "deleteAll", annotations: { destructiveHint: true } }]);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (msg.type === "tool_call") {
        app.socket.send(JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: "ok" }));
      }
    });

    const result = await rpcCall(daemon.paths.socketPath, "tools.call", {
      selector: app.alias,
      name: "deleteAll",
      args: {},
    });
    expect(result).toEqual({ result: "ok", callId: expect.any(String) });

    app.socket.close();
  });

  test("a per-tool override also beats the default-allow rule (allow-by-default, deny-by-override)", async () => {
    const { daemon, port } = await startTestDaemon({
      policy: { tools: { "pixel-8/echo": "deny" } },
    });
    const app = await claimApp(daemon, port, "Pixel 8");
    await snapshotTools(daemon, app, [{ name: "echo" }]);

    await expect(
      rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "echo", args: {} }),
    ).rejects.toMatchObject({ data: { type: "policy_denied" } });

    app.socket.close();
  });

  test("policy_denied carries a hint naming the config file", async () => {
    const { daemon, port, stateDir } = await startTestDaemon({ policy: { destructive: "deny" } });
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "deleteAll", annotations: { destructiveHint: true } }]);

    const paths = getStateDirPaths(stateDir);

    await expect(
      rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "deleteAll", args: {} }),
    ).rejects.toMatchObject({ data: { type: "policy_denied", details: { hint: expect.stringContaining(paths.configPath) } } });

    app.socket.close();
  });
});

describe("policy: config validation", () => {
  test('policy.destructive: "prompt" fails to load with the documented error', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-policy-config-"));
    stateDirs.push(stateDir);
    const paths = getStateDirPaths(stateDir);

    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ policy: { destructive: "prompt" } }));

    await expect(loadConfig(paths)).rejects.toThrow(/prompt/u);
  });

  test('policy.tools entries reject "prompt" the same way', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-policy-config-"));
    stateDirs.push(stateDir);
    const paths = getStateDirPaths(stateDir);

    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ policy: { tools: { "pixel-8/echo": "prompt" } } }));

    await expect(loadConfig(paths)).rejects.toThrow(/prompt/u);
  });
});

describe("audit: one line per tools.call attempt", () => {
  test("ok/error/denied outcomes are all recorded, args are never logged raw, and caller is attributed correctly", async () => {
    const { daemon, port, stateDir } = await startTestDaemon({ policy: { destructive: "deny" } });
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [
      { name: "echo" },
      { name: "boom" },
      { name: "deleteAll", annotations: { destructiveHint: true } },
    ]);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type !== "tool_call") {
        return;
      }

      if (msg.name === "echo") {
        app.socket.send(
          JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: "ok" }),
        );
        return;
      }

      if (msg.name === "boom") {
        app.socket.send(
          JSON.stringify({
            type: "tool_error",
            session_id: app.sessionId,
            id: msg.id,
            error: { type: "tool_execution_error", message: "boom" },
          }),
        );
      }
    });

    const sentinelSecret = "sentinel-secret-should-never-appear-in-audit-log";

    // ok, via the CLI-default caller (no `caller` param sent).
    await rpcCall(daemon.paths.socketPath, "tools.call", {
      selector: app.alias,
      name: "echo",
      args: { secret: sentinelSecret },
    });

    // error.
    await expect(
      rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "boom", args: {} }),
    ).rejects.toMatchObject({ data: { type: "tool_execution_error" } });

    // denied.
    await expect(
      rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "deleteAll", args: {} }),
    ).rejects.toMatchObject({ data: { type: "policy_denied" } });

    // A call attributed to the MCP server, driven through a real MCP server instance (not just the
    // RPC param) so the assertion covers the actual wiring in mcp/server.ts.
    const mcpHandle = await createMcpServer({ stateDir, spawn: () => { throw new Error("must not auto-spawn"); } });
    mcpHandles.push(mcpHandle);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcpHandle.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const mcpResult = await client.request(
      { method: "tools/call", params: { name: "echo", arguments: {} } },
      CallToolResultSchema,
    );
    expect(mcpResult.isError).not.toBe(true);

    app.socket.close();
    await shutdownNow(daemon);

    const rawAuditContents = await readFile(todayAuditPath(stateDir), "utf8");
    expect(rawAuditContents).not.toContain(sentinelSecret);

    const records = await readAuditRecords(stateDir);
    // Every line is parseable JSONL (readAuditRecords already threw if not) and non-empty.
    expect(records.length).toBeGreaterThanOrEqual(4);

    for (const record of records) {
      expect(record.sessionId).toBe(app.sessionId);
      expect(record.argsSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(typeof record.durationMs).toBe("number");
    }

    const okRecord = records.find((record) => record.tool === "echo" && record.outcome === "ok" && record.caller === "cli");
    expect(okRecord).toBeDefined();

    const errorRecord = records.find((record) => record.tool === "boom" && record.outcome === "error");
    expect(errorRecord?.errorType).toBe("tool_execution_error");

    const deniedRecord = records.find((record) => record.tool === "deleteAll" && record.outcome === "denied");
    expect(deniedRecord).toBeDefined();

    const mcpRecord = records.find((record) => record.tool === "echo" && record.caller === "mcp");
    expect(mcpRecord).toBeDefined();
    expect(mcpRecord?.outcome).toBe("ok");
  });
});

describe("audit: cancelled outcome", () => {
  test("tools.cancel followed by the app's tool_cancelled reply audits as cancelled", async () => {
    const { daemon, port, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "slow" }]);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_cancel") {
        app.socket.send(
          JSON.stringify({
            type: "tool_error",
            session_id: app.sessionId,
            id: msg.id,
            error: { type: "tool_cancelled", message: "cancelled" },
          }),
        );
      }
    });

    const started = waitForEvent(daemon, "tool_call_started");
    const callPromise = rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "slow", args: {} });
    const startedEvent = await started;
    const callId = (startedEvent.data as { callId: string }).callId;

    await rpcCall(daemon.paths.socketPath, "tools.cancel", { selector: app.alias, callId });

    await expect(callPromise).rejects.toMatchObject({ data: { type: "tool_cancelled" } });

    app.socket.close();
    await shutdownNow(daemon);

    const records = await readAuditRecords(stateDir);
    const cancelledRecord = records.find((record) => record.tool === "slow");
    expect(cancelledRecord?.outcome).toBe("cancelled");
    expect(cancelledRecord?.errorType).toBe("tool_cancelled");
  });
});

describe("daemon.status: policy + audit surfacing", () => {
  test("daemon.status exposes the effective policy and the audit path/failedWrites counter", async () => {
    const { daemon, port, stateDir } = await startTestDaemon({
      policy: { default: "allow", destructive: "deny", tools: { "pixel-8/echo": "allow" } },
    });
    const app = await claimApp(daemon, port, "Pixel 8");
    await snapshotTools(daemon, app, [{ name: "echo" }]);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (msg.type === "tool_call") {
        app.socket.send(JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: "ok" }));
      }
    });
    await rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "echo", args: {} });

    const status = (await rpcCall(daemon.paths.socketPath, "daemon.status")) as {
      policy: { default: string; destructive: string; tools?: Record<string, string> };
      audit: { path: string; failedWrites: number };
    };

    expect(status.policy).toEqual({ default: "allow", destructive: "deny", tools: { "pixel-8/echo": "allow" } });
    expect(status.audit.path).toBe(getStateDirPaths(stateDir).auditDir);
    expect(status.audit.failedWrites).toBe(0);

    app.socket.close();
  });
});
