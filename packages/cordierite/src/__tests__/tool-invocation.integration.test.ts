/**
 * The invocation path (`tools.list`, `tools.call` with
 * correlation/timeout/progress, `events.subscribe`). Every case drives a real pinned-TLS `wss://`
 * socket (a scripted fake app-client, plain `ws`) against a real daemon and the real UDS RPC
 * socket, per the harness pattern in `session-engine.integration.test.ts` — mocks of the
 * daemon internals would only prove the mocks were called, not that the wire protocol works.
 */

import { connect as connectUds, createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { decodeBootstrap, TOOL_ERROR_TYPES, type EventKind, type EventNotification } from "@cordierite/shared";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { writeTestHostKey } from "./fixtures.js";

// Client pinning is the app's job; tests skip it client-side for their throwaway self-signed key.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];

afterEach(async () => {
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
  port: number;
};

const startTestDaemon = async (configOverrides: Record<string, unknown> = {}): Promise<TestDaemon> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-tool-invocation-"));
  stateDirs.push(stateDir);
  await writeTestHostKey(path.join(stateDir, "key.pem"));

  const port = await pickFreePort();
  await writeFile(
    path.join(stateDir, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1", ...configOverrides }),
  );

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);

  return { daemon, port };
};

/** Raw newline-delimited JSON-RPC call over the daemon's UDS control socket. */
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

/** Opens a persistent UDS RPC connection, exposing `call` (request/response) and `onNotification`
 * (server-pushed `event` frames) — used by the `events.subscribe` tests below. */
const openRpcConnection = (
  socketPath: string,
): Promise<{
  call: (method: string, params?: unknown) => Promise<unknown>;
  notifications: EventNotification[];
  close: () => void;
}> => {
  return new Promise((resolve, reject) => {
    const socket: Socket = connectUds(socketPath);
    let buffer = "";
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
    const notifications: EventNotification[] = [];

    socket.once("connect", () => {
      socket.off("error", onConnectError);
      resolve({
        call: (method, params) => {
          return new Promise((res, rej) => {
            const id = nextId;
            nextId += 1;
            pending.set(id, { resolve: res, reject: rej });
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`);
          });
        },
        notifications,
        close: () => socket.destroy(),
      });
    });

    const onConnectError = (error: Error): void => reject(error);
    socket.once("error", onConnectError);

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (line.length === 0) {
          continue;
        }

        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { message: string; data?: unknown };
        };

        if (message.method === "event") {
          notifications.push(message.params as EventNotification);
          continue;
        }

        if (typeof message.id !== "number") {
          continue;
        }

        const inflight = pending.get(message.id);

        if (!inflight) {
          continue;
        }

        pending.delete(message.id);

        if (message.error) {
          inflight.reject(Object.assign(new Error(message.error.message), { data: message.error.data }));
        } else {
          inflight.resolve(message.result);
        }
      }
    });
  });
};

/** Waits for the next event of `kind` on the daemon's in-process bus. */
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
  resumeToken: string;
};

const createLinkAndDecode = async (
  daemon: RunningDaemon,
  port: number,
): Promise<{ sessionId: string; token: string }> => {
  const result = (await rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds: 60 })) as {
    deepLinkPayload: string;
  };
  const decoded = decodeBootstrap(result.deepLinkPayload);
  expect(decoded).not.toBeNull();

  return { sessionId: decoded!.sessionId, token: decoded!.token };
};

/** Mints a link, claims it over a fresh socket, and returns the claimed app connection. */
const claimApp = async (daemon: RunningDaemon, port: number, deviceModel = "Pixel 8"): Promise<ClaimedApp> => {
  const link = await createLinkAndDecode(daemon, port);
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

  return { socket, sessionId: link.sessionId, alias: ack.alias as string, resumeToken: ack.resume_token as string };
};

/** Sends an authoritative `tool_registry_snapshot` for one or more tools and waits for `tools_changed`. */
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

describe("tools.list / tools.call: round trip", () => {
  test("list -> call -> result round-trip, including schemas visible in tools.list", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    await snapshotTools(daemon, app, [
      {
        name: "echo",
        description: "Echoes its input.",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
      },
    ]);

    const listed = (await rpcCall(daemon.paths.socketPath, "tools.list", {
      selector: app.alias,
    })) as Array<{ name: string; input_schema?: unknown }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe("echo");
    expect(listed[0]!.input_schema).toEqual({ type: "object", properties: { text: { type: "string" } } });

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        app.socket.send(
          JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: { echoed: (msg.args as Record<string, unknown>).text } }),
        );
      }
    });

    const result = await rpcCall(daemon.paths.socketPath, "tools.call", {
      selector: app.alias,
      name: "echo",
      args: { text: "hello" },
    });

    expect(result).toEqual({ result: { echoed: "hello" }, callId: expect.any(String) });

    app.socket.close();
  });

  test("tools.list on a SUSPENDED session still returns the retained registry", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "echo" }]);

    const suspended = waitForEvent(daemon, "session_suspended");
    app.socket.close();
    await suspended;

    const listed = (await rpcCall(daemon.paths.socketPath, "tools.list", { selector: app.alias })) as unknown[];
    expect(listed).toHaveLength(1);
  });

  test("tools.call for an unregistered tool rejects tool_not_found without sending a frame to the app", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "echo" }]);

    let sawToolCall = false;
    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (msg.type === "tool_call") {
        sawToolCall = true;
      }
    });

    await expect(
      rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "does-not-exist", args: {} }),
    ).rejects.toMatchObject({ data: { type: "tool_not_found" } });

    expect(sawToolCall).toBe(false);
    app.socket.close();
  });

  test("tools.call rejects invalid_request when args is not a JSON object", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "echo" }]);

    await expect(
      rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "echo", args: "not-an-object" }),
    ).rejects.toMatchObject({ data: { type: "invalid_request" } });

    app.socket.close();
  });
});

describe("tools.call: error type preservation", () => {
  test.each(TOOL_ERROR_TYPES.map((type) => [type] as const))(
    "app tool_error type %s is preserved verbatim end-to-end",
    async (errorType) => {
      const { daemon, port } = await startTestDaemon();
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
              error: { type: errorType, message: `boom failed with ${errorType}`, details: { hint: "test" } },
            }),
          );
        }
      });

      await expect(
        rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "boom", args: {} }),
      ).rejects.toMatchObject({ data: { type: errorType, details: { hint: "test" } } });

      app.socket.close();
    },
  );
});

describe("tools.call: timeout", () => {
  test("app never replies -> tool_timeout after the configured timeoutMs", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "hangs" }]);

    // The app receives the tool_call and does nothing (simulating a hung handler).
    await expect(
      rpcCall(daemon.paths.socketPath, "tools.call", {
        selector: app.alias,
        name: "hangs",
        args: {},
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ data: { type: "tool_timeout" } });

    app.socket.close();
  }, 5000);
});

describe("tools.call: concurrency", () => {
  test("three concurrent calls interleaved out of order resolve to the right callers", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "a" }, { name: "b" }, { name: "c" }]);

    const received: Array<{ id: string; name: string }> = [];
    let resolveAllReceived!: () => void;
    const allReceived = new Promise<void>((resolve) => {
      resolveAllReceived = resolve;
    });

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as { type: string; id: string; name: string };

      if (msg.type === "tool_call") {
        received.push({ id: msg.id, name: msg.name });

        if (received.length === 3) {
          resolveAllReceived();
        }
      }
    });

    const callA = rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "a", args: {} });
    const callB = rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "b", args: {} });
    const callC = rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "c", args: {} });

    await allReceived;

    const byName = (name: string): string => received.find((call) => call.name === name)!.id;

    // Reply deliberately out of the order the calls were issued in (c, then a, then b).
    app.socket.send(JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: byName("c"), result: "c-result" }));
    app.socket.send(JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: byName("a"), result: "a-result" }));
    app.socket.send(JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: byName("b"), result: "b-result" }));

    const [resultA, resultB, resultC] = await Promise.all([callA, callB, callC]);
    expect(resultA).toEqual({ result: "a-result", callId: expect.any(String) });
    expect(resultB).toEqual({ result: "b-result", callId: expect.any(String) });
    expect(resultC).toEqual({ result: "c-result", callId: expect.any(String) });

    app.socket.close();
  });
});

describe("tools.call: suspend mid-call", () => {
  test("suspend rejects the pending call with session_suspended; a new call succeeds after resume", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "echo" }]);

    // The app receives the tool_call but the test never answers it — the socket is dropped instead.
    const pendingCall = rpcCall(daemon.paths.socketPath, "tools.call", {
      selector: app.alias,
      name: "echo",
      args: {},
    });

    const gotToolCall = new Promise<void>((resolve) => {
      app.socket.once("message", (data) => {
        const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "tool_call") {
          resolve();
        }
      });
    });
    await gotToolCall;

    const suspended = waitForEvent(daemon, "session_suspended");
    app.socket.close();
    await suspended;

    await expect(pendingCall).rejects.toMatchObject({ data: { type: "session_suspended" } });

    // Resume on a fresh socket, re-send the authoritative snapshot, then a fresh call succeeds.
    const resumedSocket = await connectClient(port);
    const resumed = waitForEvent(daemon, "session_resumed");
    resumedSocket.send(
      JSON.stringify({
        type: "session_resume",
        protocol_version: 2,
        session_id: app.sessionId,
        resume_token: app.resumeToken,
      }),
    );
    await nextMessage(resumedSocket);
    await resumed;

    const resumedApp: ClaimedApp = { ...app, socket: resumedSocket };
    await snapshotTools(daemon, resumedApp, [{ name: "echo" }]);

    resumedSocket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (msg.type === "tool_call") {
        resumedSocket.send(
          JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: "ok-after-resume" }),
        );
      }
    });

    const result = await rpcCall(daemon.paths.socketPath, "tools.call", {
      selector: app.alias,
      name: "echo",
      args: {},
    });
    expect(result).toEqual({ result: "ok-after-resume", callId: expect.any(String) });

    resumedSocket.close();
  }, 10_000);
});

describe("events.subscribe", () => {
  test("a subscriber receives session_claimed, tools_changed, app_event, tool_call_started/finished in order", async () => {
    const { daemon, port } = await startTestDaemon();

    const connection = await openRpcConnection(daemon.paths.socketPath);
    await connection.call("events.subscribe", {});

    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "echo" }]);

    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "custom_event", ts: Date.now() }));
    await waitForEvent(daemon, "app_event");

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (msg.type === "tool_call") {
        app.socket.send(JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: "ok" }));
      }
    });

    // Subscribed before the call: the daemon emits `tool_call_finished` before the RPC response
    // is flushed to the client, so awaiting the event *after* `rpcCall` resolves would race it.
    const finished = waitForEvent(daemon, "tool_call_finished");
    await rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "echo", args: {} });
    await finished;

    // Give the fan-out a beat to flush onto the subscriber's own socket buffer.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const kinds = connection.notifications.map((n) => n.kind);
    expect(kinds).toContain("session_claimed");
    expect(kinds).toContain("tools_changed");
    expect(kinds).toContain("app_event");
    expect(kinds).toContain("tool_call_started");
    expect(kinds).toContain("tool_call_finished");

    const claimedIndex = kinds.indexOf("session_claimed");
    const toolsChangedIndex = kinds.indexOf("tools_changed");
    const appEventIndex = kinds.indexOf("app_event");
    const startedIndex = kinds.indexOf("tool_call_started");
    const finishedIndex = kinds.indexOf("tool_call_finished");

    expect(claimedIndex).toBeLessThan(toolsChangedIndex);
    expect(toolsChangedIndex).toBeLessThan(appEventIndex);
    expect(appEventIndex).toBeLessThan(startedIndex);
    expect(startedIndex).toBeLessThan(finishedIndex);

    connection.close();
    app.socket.close();
  });

  test("a subscriber with a kinds filter receives only the filtered subset", async () => {
    const { daemon, port } = await startTestDaemon();

    const filtered = await openRpcConnection(daemon.paths.socketPath);
    await filtered.call("events.subscribe", { kinds: ["tools_changed"] });

    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "echo" }]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const kinds = new Set(filtered.notifications.map((n) => n.kind));
    expect(kinds.has("tools_changed")).toBe(true);
    expect(kinds.has("session_claimed")).toBe(false);

    filtered.close();
    app.socket.close();
  });
});

describe("events.since", () => {
  test("drains retained app_events with no live subscription, and cursor advances", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const first = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "a", ts: Date.now() }));
    await first;

    const second = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "b", ts: Date.now() }));
    await second;

    const since = (await rpcCall(daemon.paths.socketPath, "events.since", { selector: app.alias })) as {
      events: Array<{ kind: string; seq: number; data: { name: string } }>;
      cursor: number;
    };

    const appEvents = since.events.filter((event) => event.kind === "app_event");
    expect(appEvents.map((event) => event.data.name)).toEqual(["a", "b"]);
    expect(since.cursor).toBe(appEvents[appEvents.length - 1]!.seq);

    // A second pull with `since` set to the first response's cursor sees nothing new.
    const drained = (await rpcCall(daemon.paths.socketPath, "events.since", {
      selector: app.alias,
      since: since.cursor,
    })) as { events: unknown[] };
    expect(drained.events).toEqual([]);

    app.socket.close();
  });

  test("selector defaults to the sole active/suspended session, matching sessions.describe", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const emitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "solo", ts: Date.now() }));
    await emitted;

    const since = (await rpcCall(daemon.paths.socketPath, "events.since", {})) as {
      events: Array<{ kind: string; data: { name: string } }>;
    };
    expect(since.events.some((event) => event.kind === "app_event" && event.data.name === "solo")).toBe(true);

    app.socket.close();
  });

  test("a terminal transition discards the retained buffer", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    const emitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "before-revoke", ts: Date.now() }));
    await emitted;

    const revoked = waitForEvent(daemon, "session_revoked");
    await rpcCall(daemon.paths.socketPath, "sessions.revoke", { selector: app.alias });
    await revoked;

    await expect(
      rpcCall(daemon.paths.socketPath, "events.since", { selector: app.sessionId }),
    ).rejects.toMatchObject({ data: { type: "unknown_session" } });
  });

  test("no_session and ambiguous_session error types, matching every other selector-taking method", async () => {
    const { daemon, port } = await startTestDaemon();

    await expect(rpcCall(daemon.paths.socketPath, "events.since", {})).rejects.toMatchObject({
      data: { type: "no_session" },
    });

    const appA = await claimApp(daemon, port, "Pixel 8");
    const appB = await claimApp(daemon, port, "Pixel 8");

    await expect(rpcCall(daemon.paths.socketPath, "events.since", {})).rejects.toMatchObject({
      data: { type: "ambiguous_session" },
    });

    appA.socket.close();
    appB.socket.close();
  });

  test("limit keeps the oldest N and cursor pages forward, never skipping a retained event", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);

    for (const name of ["a", "b", "c"]) {
      const emitted = waitForEvent(daemon, "app_event");
      app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name, ts: Date.now() }));
      await emitted;
    }

    const first = (await rpcCall(daemon.paths.socketPath, "events.since", {
      selector: app.alias,
      kinds: ["app_event"],
      limit: 1,
    })) as { events: Array<{ data: { name: string } }>; cursor: number };
    expect(first.events.map((event) => event.data.name)).toEqual(["a"]);

    const second = (await rpcCall(daemon.paths.socketPath, "events.since", {
      selector: app.alias,
      kinds: ["app_event"],
      since: first.cursor,
      limit: 1,
    })) as { events: Array<{ data: { name: string } }>; cursor: number };
    expect(second.events.map((event) => event.data.name)).toEqual(["b"]);

    const third = (await rpcCall(daemon.paths.socketPath, "events.since", {
      selector: app.alias,
      kinds: ["app_event"],
      since: second.cursor,
      limit: 1,
    })) as { events: Array<{ data: { name: string } }> };
    expect(third.events.map((event) => event.data.name)).toEqual(["c"]);

    app.socket.close();
  });

  test("tool_call_progress is fanned out live but never retained, so it can't evict app_events", async () => {
    const { daemon, port } = await startTestDaemon();
    const app = await claimApp(daemon, port);
    await snapshotTools(daemon, app, [{ name: "slow" }]);

    const appEventEmitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "before-progress", ts: Date.now() }));
    await appEventEmitted;

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        for (let i = 0; i < 10; i++) {
          app.socket.send(
            JSON.stringify({ type: "tool_call_progress", session_id: app.sessionId, id: msg.id, progress: i / 10 }),
          );
        }
        app.socket.send(JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: "ok" }));
      }
    });

    const finished = waitForEvent(daemon, "tool_call_finished");
    await rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "slow", args: {} });
    await finished;

    const since = (await rpcCall(daemon.paths.socketPath, "events.since", { selector: app.alias })) as {
      events: Array<{ kind: string }>;
    };
    expect(since.events.some((event) => event.kind === "tool_call_progress")).toBe(false);
    expect(since.events.some((event) => event.kind === "app_event")).toBe(true);

    app.socket.close();
  });
});

describe("tools.* selectors", () => {
  test("unknown_session and ambiguous_session error types", async () => {
    const { daemon, port } = await startTestDaemon();

    await expect(
      rpcCall(daemon.paths.socketPath, "tools.call", { selector: "does-not-exist", name: "echo", args: {} }),
    ).rejects.toMatchObject({ data: { type: "unknown_session" } });

    const appA = await claimApp(daemon, port, "Pixel 8");
    const appB = await claimApp(daemon, port, "Pixel 8");

    await expect(rpcCall(daemon.paths.socketPath, "tools.list")).rejects.toMatchObject({
      data: { type: "ambiguous_session" },
    });

    appA.socket.close();
    appB.socket.close();
  });
});
