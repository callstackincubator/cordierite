import type {
  SessionAckMessage,
  StandardSchemaV1,
  StandardSchemaV1JsonSchema,
} from "@cordierite/shared";
import { describe, expect, test } from "vitest";
import { z as z3 } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z as z4 } from "zod4";

import type {
  CordieriteConnectionState,
  CordieriteSessionChangeEvent,
  CordieriteUnifiedErrorEvent,
  CordieriteUnifiedStateChangeEvent,
} from "../Cordierite.types";
import { createCordieriteClient } from "../client";
import type { AppStateLike, AppStateStatus } from "../client/app-state";
import type { ClientTimerHandle, ClientTimers } from "../client/timers";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Listener = (event: any) => void;

const createMockModule = (initialState: CordieriteConnectionState = "idle") => {
  const listeners = new Map<string, Set<Listener>>();
  const sentMessages: string[] = [];
  const connectCalls: unknown[] = [];

  return {
    sentMessages,
    connectCalls,
    listeners,
    state: initialState,
    async connect(options: unknown) {
      connectCalls.push(options);
      // Real native `connect()` resolves once TLS is up and the first frame has been sent, at
      // which point its own (raw, resume-unaware) connection state is "active" -- independent of
      // whether the JS client has seen a `session_ack` yet.
      this.state = "active";
    },
    async send(message: string) {
      sentMessages.push(message);
    },
    async close() {
      this.state = "closed";
    },
    getState() {
      return this.state;
    },
    addListener(eventName: string, listener: Listener) {
      const eventListeners = listeners.get(eventName) ?? new Set();
      eventListeners.add(listener);
      listeners.set(eventName, eventListeners);
      return {
        remove() {
          eventListeners.delete(listener);
        },
      };
    },
    emit(eventName: string, event: unknown) {
      listeners.get(eventName)?.forEach((listener) => listener(event));
    },
  };
};

type MockModule = ReturnType<typeof createMockModule>;

type FakeTimerEntry = { id: number; dueAt: number; callback: () => void };

const createFakeTimers = (
  options: { randomValues?: number[] } = {}
): ClientTimers & { advance(ms: number): void; pendingCount(): number } => {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map<number, FakeTimerEntry>();
  const randomQueue = [...(options.randomValues ?? [])];

  return {
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { id, dueAt: currentTime + ms, callback });
      return id as unknown as ClientTimerHandle;
    },
    clearTimeout(handle) {
      timers.delete(handle as unknown as number);
    },
    now: () => currentTime,
    random: () => (randomQueue.length > 0 ? randomQueue.shift()! : 0.5),
    advance(ms: number) {
      currentTime += ms;
      let firedSomething = true;
      while (firedSomething) {
        firedSomething = false;
        const due = [...timers.values()]
          .filter((entry) => entry.dueAt <= currentTime)
          .sort((a, b) => a.dueAt - b.dueAt);
        for (const entry of due) {
          if (!timers.has(entry.id)) {
            continue;
          }
          timers.delete(entry.id);
          firedSomething = true;
          entry.callback();
        }
      }
    },
    pendingCount: () => timers.size,
  };
};

const createFakeAppState = (
  initial: AppStateStatus = "active"
): AppStateLike & { setState(next: AppStateStatus): void } => {
  let current = initial;
  const listeners = new Set<(state: AppStateStatus) => void>();

  return {
    get currentState() {
      return current;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
      return {
        remove() {
          listeners.delete(listener);
        },
      };
    },
    setState(next) {
      current = next;
      listeners.forEach((listener) => listener(next));
    },
  };
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const validExpiresAt = () => Math.floor(Date.now() / 1000) + 60;

const validBootstrap = () => ({
  ip: "192.168.1.42",
  port: 8443,
  sessionId: "session-123",
  token: "token-123",
  expiresAt: validExpiresAt(),
});

const buildAck = (
  overrides: Partial<SessionAckMessage> = {}
): SessionAckMessage => ({
  type: "session_ack",
  session_id: "session-123",
  status: "ok",
  alias: "device-1",
  resume_token: "resume-token-1",
  keepalive_interval_s: 15,
  grace_s: 600,
  ...overrides,
});

const validResumeLease = () => ({
  schemaVersion: 1 as const,
  sessionId: "session-123",
  resumeToken: "resume-token-1",
  alias: "device-1",
  endpoint: { ip: "192.168.1.42", port: 8443 },
  keepaliveIntervalS: 15,
  graceS: 600,
  disconnectedAtMs: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const success = <T>(value: T): StandardSchemaV1.SuccessResult<T> => ({ value });

const anyObjectSchema: StandardSchemaV1JsonSchema<
  unknown,
  Record<string, unknown>
> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      isRecord(value)
        ? success(value)
        : { issues: [{ message: "Expected object input." }] },
    jsonSchema: {
      input: () => ({ type: "object", additionalProperties: true }),
      output: () => ({ type: "object", additionalProperties: true }),
    },
  },
};

/** Fires an incoming native `message` event carrying `payload` as the (already parsed) message. */
const fireMessage = (module: MockModule, payload: unknown) => {
  module.emit("message", { message: payload, rawMessage: "" });
};

const fireClose = (
  module: MockModule,
  event: { code?: number; reason?: string } = {}
) => {
  // Real native transitions its own connection state away from "active" once the underlying
  // socket actually closes, before it notifies JS -- otherwise a fresh `connect()` call made in
  // response to the loss would be incorrectly rejected as "already active".
  module.state = "closed";
  module.emit("close", event);
};

// ---------------------------------------------------------------------------
// claim -> ack -> snapshot
// ---------------------------------------------------------------------------

describe("createCordieriteClient: claim handshake", () => {
  test("connect rejects expired payloads before native connect", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    await expect(
      client.connect({ ...validBootstrap(), expiresAt: 1 })
    ).rejects.toThrow("Invalid or expired Cordierite bootstrap payload.");
    expect(nativeModule.connectCalls).toEqual([]);
  });

  test("connect rejects when native reports already connecting/active", async () => {
    const nativeModule = createMockModule("active");
    const client = createCordieriteClient(nativeModule);

    await expect(client.connect(validBootstrap())).rejects.toThrow(
      "A Cordierite session is already connecting or active."
    );
  });

  test("claim -> session_ack -> active state -> full registry snapshot", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool({
      name: "echo",
      description: "Echo tool",
      inputSchema: anyObjectSchema,
      outputSchema: anyObjectSchema,
      handler: (args) => args,
    });

    const stateEvents: CordieriteUnifiedStateChangeEvent[] = [];
    const sessionEvents: CordieriteSessionChangeEvent[] = [];
    client.addCordieriteListener("stateChange", (e) => stateEvents.push(e));
    client.addCordieriteListener("sessionChange", (e) => sessionEvents.push(e));

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    expect(client.getClientState()).toBe("active");
    expect(stateEvents.map((e) => e.state)).toEqual(["connecting", "active"]);
    expect(sessionEvents).toEqual([
      { type: "claimed", sessionId: "session-123", alias: "device-1" },
    ]);

    await flushMicrotasks();
    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: "session-123",
        tools: [
          {
            name: "echo",
            description: "Echo tool",
            input_schema: { type: "object", additionalProperties: true },
            output_schema: { type: "object", additionalProperties: true },
          },
        ],
      })
    );
  });

  test("a raw JSON Schema and a zod 3 pair both reach tool_registry_snapshot with a real shape (issue #27)", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    const rawInput = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    };

    client.registerTool({
      name: "weather",
      description: "Raw JSON Schema tool",
      inputSchema: rawInput,
      handler: () => undefined,
    });

    const zod3Input = z3.object({ a: z3.number() });
    client.registerTool({
      name: "sum",
      description: "zod 3 paired tool",
      inputSchema: {
        schema: zod3Input,
        jsonSchema: zodToJsonSchema(zod3Input, {
          target: "jsonSchema2019-09",
        }) as Record<string, unknown>,
      },
      handler: () => undefined,
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;
    await flushMicrotasks();

    const snapshot = nativeModule.sentMessages
      .map((json) => JSON.parse(json) as Record<string, unknown>)
      .find((message) => message.type === "tool_registry_snapshot");

    expect(snapshot).toBeDefined();
    const tools = snapshot?.tools as { name: string; input_schema?: unknown }[];

    expect(tools.find((tool) => tool.name === "weather")?.input_schema).toEqual(
      rawInput,
    );
    expect(
      tools.find((tool) => tool.name === "sum")?.input_schema,
    ).toMatchObject({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });
  });

  test("a real zod 4 schema publishes a real input_schema through its own exporter (issue #27)", async () => {
    // Not a hand-rolled `~standard.jsonSchema` double: this exercises zod 4's built-in exporter
    // end to end, so a change in how zod exports (or in how we call it) fails here.
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool({
      name: "zod4-sum",
      description: "zod 4 tool",
      inputSchema: z4.object({ a: z4.number(), b: z4.string() }),
      outputSchema: z4.object({ total: z4.number() }),
      handler: ({ a }) => ({ total: a }),
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;
    await flushMicrotasks();

    const snapshot = nativeModule.sentMessages
      .map((json) => JSON.parse(json) as Record<string, unknown>)
      .find((message) => message.type === "tool_registry_snapshot");
    const tool = (
      snapshot?.tools as {
        name: string;
        input_schema?: Record<string, unknown>;
        output_schema?: Record<string, unknown>;
      }[]
    ).find((entry) => entry.name === "zod4-sum");

    expect(tool?.input_schema).toMatchObject({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "string" } },
      required: ["a", "b"],
    });
    expect(tool?.output_schema).toMatchObject({
      type: "object",
      properties: { total: { type: "number" } },
    });
  });

  test("registering a bare zod 3 schema throws in dev, naming the supported forms (issue #27)", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    expect(() =>
      client.registerTool({
        name: "shapeless",
        description: "zod 3 without an exporter",
        inputSchema: z3.object({ a: z3.number() }),
        handler: () => undefined,
      }),
    ).toThrow(/schema, jsonSchema/);

    expect(client.getRegisteredTools()).toEqual([]);
  });

  test("connect surfaces native connect() rejection on the unified error channel and rethrows", async () => {
    const nativeModule = createMockModule();
    nativeModule.connect = async () => {
      throw new Error("native connect failed");
    };
    const client = createCordieriteClient(nativeModule);

    const errors: CordieriteUnifiedErrorEvent[] = [];
    client.addCordieriteListener("error", (e) => errors.push(e));

    await expect(client.connect(validBootstrap())).rejects.toThrow(
      "native connect failed"
    );
    expect(client.getClientState()).toBe("closed");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.phase).toBe("connect");
  });

  test("close() rejects an in-flight connect() instead of leaving it hanging forever", async () => {
    const nativeModule = createMockModule();
    // Native `connect()` accepts the call but never actually gets an ack -- the handshake stays
    // in flight until something settles it.
    const client = createCordieriteClient(nativeModule);

    const connectPromise = client.connect(validBootstrap());
    await client.close();

    await expect(connectPromise).rejects.toThrow(
      "Cordierite client was closed."
    );
  });

  test("destroy() rejects an in-flight connect() instead of leaving it hanging forever", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    const connectPromise = client.connect(validBootstrap());
    client.destroy();

    await expect(connectPromise).rejects.toThrow(
      "Cordierite client was destroyed."
    );
  });
});

// ---------------------------------------------------------------------------
// runtime replacement -> restore native-owned resume lease
// ---------------------------------------------------------------------------

describe("createCordieriteClient: restore session after runtime replacement", () => {
  test("a fresh client resumes from the shared lease and sends a full registry snapshot", async () => {
    let storedLease: unknown = null;
    const resumeLeaseStore = {
      get: () => storedLease,
      clear: () => {
        storedLease = null;
      },
    };

    const firstNativeModule = createMockModule();
    const firstClient = createCordieriteClient(firstNativeModule, {
      resumeLeaseStore,
    });
    const firstConnect = firstClient.connect(validBootstrap());
    fireMessage(firstNativeModule, buildAck());
    await firstConnect;

    // Native will own this write in production. The shared fake models its process-memory lease.
    storedLease = validResumeLease();
    firstClient.destroy();

    const replacementNativeModule = createMockModule();
    const replacementClient = createCordieriteClient(replacementNativeModule, {
      resumeLeaseStore,
    });
    replacementClient.registerTool({
      name: "echo",
      description: "Echo tool",
      handler: () => {},
    });
    const sessionEvents: CordieriteSessionChangeEvent[] = [];
    replacementClient.addCordieriteListener("sessionChange", (event) =>
      sessionEvents.push(event)
    );

    await expect(replacementClient.restoreSession()).resolves.toBe(true);
    expect(replacementClient.getClientState()).toBe("reconnecting");
    expect(replacementNativeModule.connectCalls).toHaveLength(1);
    expect(replacementNativeModule.connectCalls[0]).toMatchObject({
      ip: "192.168.1.42",
      port: 8443,
      sessionId: "session-123",
      resumeToken: "resume-token-1",
    });

    fireMessage(
      replacementNativeModule,
      buildAck({ resume_token: "resume-token-2" })
    );
    await flushMicrotasks();

    expect(replacementClient.getClientState()).toBe("active");
    expect(sessionEvents).toEqual([
      { type: "resumed", sessionId: "session-123", alias: "device-1" },
    ]);
    expect(replacementNativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: "session-123",
        tools: [{ name: "echo", description: "Echo tool" }],
      })
    );
  });

  test("a malformed stored lease is cleared and ignored", async () => {
    let storedLease: unknown = {
      ...validResumeLease(),
      resumeToken: "x".repeat(129),
    };
    let clearCalls = 0;
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule, {
      resumeLeaseStore: {
        get: () => storedLease,
        clear: () => {
          clearCalls += 1;
          storedLease = null;
        },
      },
    });

    await expect(client.restoreSession()).resolves.toBe(false);
    expect(client.getClientState()).toBe("idle");
    expect(nativeModule.connectCalls).toEqual([]);
    expect(clearCalls).toBe(1);
  });

  test("an expired stored lease is cleared without starting recovery", async () => {
    let storedLease: unknown = {
      ...validResumeLease(),
      graceS: 2,
      disconnectedAtMs: 1_000,
    };
    let clearCalls = 0;
    const timers = createFakeTimers();
    timers.advance(3_000);
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule, {
      timers,
      resumeLeaseStore: {
        get: () => storedLease,
        clear: () => {
          clearCalls += 1;
          storedLease = null;
        },
      },
    });

    await expect(client.restoreSession()).resolves.toBe(false);
    expect(client.getClientState()).toBe("idle");
    expect(nativeModule.connectCalls).toEqual([]);
    expect(clearCalls).toBe(1);
  });

  test("explicit close clears a restored lease", async () => {
    let storedLease: unknown = validResumeLease();
    let clearCalls = 0;
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule, {
      resumeLeaseStore: {
        get: () => storedLease,
        clear: () => {
          clearCalls += 1;
          storedLease = null;
        },
      },
    });

    await client.restoreSession();
    await client.close();

    expect(storedLease).toBeNull();
    expect(clearCalls).toBe(1);
  });

  test("a fresh manual connect supersedes an in-flight restoration", async () => {
    let storedLease: unknown = validResumeLease();
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule, {
      resumeLeaseStore: {
        get: () => storedLease,
        clear: () => {
          storedLease = null;
        },
      },
    });

    await client.restoreSession();
    const freshConnect = client.connect({
      ...validBootstrap(),
      sessionId: "session-fresh",
    });
    await flushMicrotasks();
    fireMessage(nativeModule, buildAck({ session_id: "session-fresh" }));
    await freshConnect;

    expect(nativeModule.connectCalls).toHaveLength(2);
    expect(client.getClientState()).toBe("active");
    expect(storedLease).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// socket loss -> resume -> rotated token -> fresh snapshot
// ---------------------------------------------------------------------------

describe("createCordieriteClient: resume after socket loss", () => {
  test("resumes with a rotated token and re-sends the full registry snapshot", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers({ randomValues: [0, 0, 0, 0] });
    const client = createCordieriteClient(nativeModule, { timers });

    client.registerTool({
      name: "echo",
      description: "Echo tool",
      handler: () => {},
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck({ resume_token: "resume-token-1" }));
    await connectPromise;
    nativeModule.sentMessages.length = 0;

    const sessionEvents: CordieriteSessionChangeEvent[] = [];
    client.addCordieriteListener("sessionChange", (e) => sessionEvents.push(e));

    // Socket lost (not a revoke: any non-1000 close code).
    fireClose(nativeModule, { code: 1006, reason: "abnormal closure" });
    expect(client.getClientState()).toBe("reconnecting");

    // Reconnect backoff timer fires -> native `connect` called again with `session_resume` shape.
    timers.advance(1);
    expect(nativeModule.connectCalls).toHaveLength(2);
    const resumeOptions = nativeModule.connectCalls[1] as {
      resumeToken?: string;
      token?: string;
    };
    expect(resumeOptions.resumeToken).toBe("resume-token-1");
    expect(resumeOptions.token).toBeUndefined();

    fireMessage(
      nativeModule,
      buildAck({ resume_token: "resume-token-2", alias: "device-1" })
    );
    await flushMicrotasks();

    expect(client.getClientState()).toBe("active");
    expect(sessionEvents).toEqual([
      { type: "resumed", sessionId: "session-123", alias: "device-1" },
    ]);
    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: "session-123",
        tools: [{ name: "echo", description: "Echo tool" }],
      })
    );

    // A second loss must resume with the *rotated* token, proving it isn't stuck on the first one.
    fireClose(nativeModule, { code: 1006 });
    timers.advance(1);
    const secondResumeOptions = nativeModule.connectCalls[2] as {
      resumeToken?: string;
    };
    expect(secondResumeOptions.resumeToken).toBe("resume-token-2");
  });

  test("code 1000 (sessions.revoke) ends the session immediately without scheduling a retry", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers();
    let storedLease: unknown = validResumeLease();
    const client = createCordieriteClient(nativeModule, {
      timers,
      resumeLeaseStore: {
        get: () => storedLease,
        clear: () => {
          storedLease = null;
        },
      },
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    const sessionEvents: CordieriteSessionChangeEvent[] = [];
    client.addCordieriteListener("sessionChange", (e) => sessionEvents.push(e));

    fireClose(nativeModule, { code: 1000, reason: "revoked" });

    expect(client.getClientState()).toBe("closed");
    expect(sessionEvents).toEqual([
      {
        type: "lost",
        sessionId: "session-123",
        alias: "device-1",
        reason: "revoked",
      },
    ]);
    expect(timers.pendingCount()).toBe(0);
    expect(storedLease).toBeNull();
  });

  test("a 1008 rejection of the resume itself ends the session instead of retrying until grace", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers({ randomValues: [0, 0] });
    let storedLease: unknown = validResumeLease();
    const client = createCordieriteClient(nativeModule, {
      timers,
      resumeLeaseStore: {
        get: () => storedLease,
        clear: () => {
          storedLease = null;
        },
      },
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    const sessionEvents: CordieriteSessionChangeEvent[] = [];
    client.addCordieriteListener("sessionChange", (e) => sessionEvents.push(e));

    // Transport-level loss: retryable, so the backoff loop starts as usual.
    fireClose(nativeModule, { code: 1006, reason: "abnormal closure" });
    expect(client.getClientState()).toBe("reconnecting");

    // The retry goes out, and *this* time the daemon rejects the resume itself — the shape of a
    // daemon restart (sessions are in-memory only), or a session revoked/expired while offline.
    // The close settles the in-flight handshake, so it never reaches `onSocketLost`.
    timers.advance(1);
    expect(nativeModule.connectCalls).toHaveLength(2);
    fireClose(nativeModule, { code: 1008, reason: "unknown_session" });
    await flushMicrotasks();

    expect(client.getClientState()).toBe("closed");
    expect(sessionEvents).toEqual([
      {
        type: "lost",
        sessionId: "session-123",
        alias: "device-1",
        reason: "unknown_session",
      },
    ]);
    // No further retry is scheduled, and the unusable lease is gone.
    expect(timers.pendingCount()).toBe(0);
    expect(storedLease).toBeNull();

    timers.advance(60_000);
    expect(nativeModule.connectCalls).toHaveLength(2);
  });

  test("a 1008 close mid-session ends it immediately (no reconnect loop)", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers();
    const client = createCordieriteClient(nativeModule, { timers });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    const sessionEvents: CordieriteSessionChangeEvent[] = [];
    const errorEvents: CordieriteUnifiedErrorEvent[] = [];
    client.addCordieriteListener("sessionChange", (e) => sessionEvents.push(e));
    client.addCordieriteListener("error", (e) => errorEvents.push(e));

    fireClose(nativeModule, { code: 1008, reason: "invalid_message" });

    expect(client.getClientState()).toBe("closed");
    expect(sessionEvents).toEqual([
      {
        type: "lost",
        sessionId: "session-123",
        alias: "device-1",
        reason: "invalid_message",
      },
    ]);
    // The rejection still reaches the unified error channel before the session is finalized.
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.closeReason).toBe("invalid_message");
    expect(timers.pendingCount()).toBe(0);
  });

  test("1011 and 1001 stay retryable: only 1008 is treated as terminal", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers({ randomValues: [0, 0] });
    const client = createCordieriteClient(nativeModule, { timers });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    // `send_failed` — a transport hiccup, not a rejection of the session.
    fireClose(nativeModule, { code: 1011, reason: "send_failed" });
    expect(client.getClientState()).toBe("reconnecting");

    timers.advance(1);
    expect(nativeModule.connectCalls).toHaveLength(2);

    // `daemon_shutdown` — the daemon may well come back inside the grace window.
    fireClose(nativeModule, { code: 1001, reason: "daemon_shutdown" });
    await flushMicrotasks();
    expect(client.getClientState()).toBe("reconnecting");

    timers.advance(1);
    expect(nativeModule.connectCalls).toHaveLength(3);
  });

  test("a fresh connect() supersedes and stops any in-flight reconnect loop", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers({ randomValues: [0] });
    const client = createCordieriteClient(nativeModule, { timers });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    fireClose(nativeModule, { code: 1006 });
    expect(client.getClientState()).toBe("reconnecting");

    const secondConnect = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck({ resume_token: "resume-token-9" }));
    await secondConnect;

    expect(client.getClientState()).toBe("active");
    // The stale reconnect timer from the first loss must not fire a competing resume.
    timers.advance(60_000);
    expect(client.getClientState()).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// grace expiry
// ---------------------------------------------------------------------------

describe("createCordieriteClient: grace expiry", () => {
  test("the first socket loss gets a full grace window after a long active session", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers({ randomValues: [0] });
    const client = createCordieriteClient(nativeModule, { timers });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck({ grace_s: 2 }));
    await connectPromise;

    timers.advance(60_000);
    fireClose(nativeModule, { code: 1006 });

    expect(client.getClientState()).toBe("reconnecting");
    timers.advance(1);
    expect(nativeModule.connectCalls).toHaveLength(2);
  });

  test("stops retries and emits a terminal stateChange once grace_s has elapsed", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers({ randomValues: [0] });
    const client = createCordieriteClient(nativeModule, { timers });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck({ grace_s: 2 }));
    await connectPromise;

    // The resume attempt that the backoff timer triggers never settles (native hangs) so grace
    // expiry -- not a resume failure -- is what ends the session.
    nativeModule.connect = () => new Promise<void>(() => {});

    const stateEvents: CordieriteUnifiedStateChangeEvent[] = [];
    const sessionEvents: CordieriteSessionChangeEvent[] = [];
    client.addCordieriteListener("stateChange", (e) => stateEvents.push(e));
    client.addCordieriteListener("sessionChange", (e) => sessionEvents.push(e));

    fireClose(nativeModule, { code: 1006 });
    timers.advance(1); // start the hanging resume attempt
    timers.advance(1_999); // let its grace budget expire while the handshake is in flight

    expect(client.getClientState()).toBe("closed");
    expect(stateEvents.at(-1)).toEqual({
      state: "closed",
      reason: "grace_expired",
    });
    expect(sessionEvents).toEqual([
      {
        type: "lost",
        sessionId: "session-123",
        alias: "device-1",
        reason: "grace_expired",
      },
    ]);
    expect(timers.pendingCount()).toBe(0);

    // A late ack from the resume attempt must not resurrect a terminally expired session.
    fireMessage(nativeModule, buildAck({ resume_token: "late-token" }));
    await flushMicrotasks();
    expect(client.getClientState()).toBe("closed");
    expect(sessionEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AppState background/foreground gating
// ---------------------------------------------------------------------------

describe("createCordieriteClient: AppState gating", () => {
  test("backgrounding pauses reconnect attempts; foregrounding retries immediately", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers({ randomValues: [0] });
    const appState = createFakeAppState("active");
    const client = createCordieriteClient(nativeModule, { timers, appState });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck({ grace_s: 600 }));
    await connectPromise;

    appState.setState("background");
    fireClose(nativeModule, { code: 1006 });

    expect(client.getClientState()).toBe("reconnecting");
    // No reconnect timer scheduled while backgrounded (the open socket is left for the OS).
    expect(timers.pendingCount()).toBe(1); // only the grace timer
    expect(nativeModule.connectCalls).toHaveLength(1);

    appState.setState("active");
    // Foregrounding while disconnected triggers an immediate resume attempt.
    expect(nativeModule.connectCalls).toHaveLength(2);

    fireMessage(nativeModule, buildAck({ resume_token: "resume-after-fg" }));
    await flushMicrotasks();
    expect(client.getClientState()).toBe("active");
  });

  test("does not tear down an already-open socket on backgrounding (no client.close() call)", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers();
    const appState = createFakeAppState("active");
    const client = createCordieriteClient(nativeModule, { timers, appState });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    appState.setState("background");
    expect(client.getClientState()).toBe("active");
    expect(nativeModule.getState()).not.toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// registry: stale disposer + duplicate-name warning (v1 defects)
// ---------------------------------------------------------------------------

describe("createCordieriteClient: tool registry", () => {
  test("a stale disposer from an earlier registration is a no-op (v1 defect: stale disposer)", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    const first = client.registerTool({
      name: "foo",
      description: "First registration",
      handler: () => "first",
    });
    const second = client.registerTool({
      name: "foo",
      description: "Second registration",
      handler: () => "second",
    });

    first.remove();

    expect(client.getRegisteredTools()).toEqual([
      { name: "foo", description: "Second registration" },
    ]);

    second.remove();
    expect(client.getRegisteredTools()).toEqual([]);
  });

  test("registering a duplicate name overwrites and logs a dev warning", () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      client.registerTool({
        name: "foo",
        description: "v1",
        handler: () => {},
      });
      client.registerTool({
        name: "foo",
        description: "v2",
        handler: () => {},
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(client.getRegisteredTools()).toEqual([
      { name: "foo", description: "v2" },
    ]);
    expect(
      warnings.some((args) =>
        args.some(
          (arg) => typeof arg === "string" && arg.includes("already registered")
        )
      )
    ).toBe(true);
  });

  test("only an explicitly declared timeoutMs reaches the descriptor, never defaultToolTimeoutMs (issue #25)", () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule, {
      defaultToolTimeoutMs: 45_000,
    });

    client.registerTool({
      name: "declared",
      description: "Declares its own deadline",
      timeoutMs: 60_000,
      handler: () => {},
    });
    client.registerTool({
      name: "undeclared",
      description: "Declares nothing",
      handler: () => {},
    });

    // The app-wide default is an app-side abort-timer fallback only: putting it on the wire would
    // silently retune every older app's daemon-side deadline.
    expect(client.getRegisteredTools()).toEqual([
      {
        name: "declared",
        description: "Declares its own deadline",
        timeoutMs: 60_000,
      },
      { name: "undeclared", description: "Declares nothing" },
    ]);
  });

  test("a registry-sync send failure is reported on the unified error channel, not thrown (v1 defect: unhandled fire-and-forget)", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    const errors: CordieriteUnifiedErrorEvent[] = [];
    client.addCordieriteListener("error", (e) => errors.push(e));

    nativeModule.send = async () => {
      throw new Error("socket write failed");
    };

    client.registerTool({
      name: "late",
      description: "late tool",
      handler: () => {},
    });
    await flushMicrotasks();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: "socket" });
  });
});

// ---------------------------------------------------------------------------
// incoming tool_call handling: timeout + v1 defect (sendWire outside try/catch)
// ---------------------------------------------------------------------------

describe("createCordieriteClient: incoming tool calls", () => {
  test("a handler that exceeds its timeout gets tool_timeout; the late result is ignored", async () => {
    const nativeModule = createMockModule();
    const timers = createFakeTimers();
    const client = createCordieriteClient(nativeModule, { timers });

    let resolveHandler!: (value: unknown) => void;
    client.registerTool({
      name: "slow",
      description: "Slow tool",
      timeoutMs: 1_000,
      handler: () => new Promise((resolve) => (resolveHandler = resolve)),
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;
    nativeModule.sentMessages.length = 0;

    fireMessage(nativeModule, {
      type: "tool_call",
      session_id: "session-123",
      id: "call-1",
      name: "slow",
      args: {},
    });

    timers.advance(1_000);
    await flushMicrotasks();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_error",
        session_id: "session-123",
        id: "call-1",
        error: {
          type: "tool_timeout",
          message: 'Tool "slow" did not respond within 1000ms.',
        },
      })
    );

    nativeModule.sentMessages.length = 0;
    resolveHandler({});
    await flushMicrotasks();
    expect(nativeModule.sentMessages).toEqual([]);
  });

  test("a failure to send a tool response is reported, not thrown (v1 defect: sendWire outside try/catch)", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool({
      name: "echo",
      description: "Echo",
      handler: () => ({}),
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    nativeModule.send = async () => {
      throw new Error("socket write failed");
    };

    const errors: CordieriteUnifiedErrorEvent[] = [];
    client.addCordieriteListener("error", (e) => errors.push(e));

    fireMessage(nativeModule, {
      type: "tool_call",
      session_id: "session-123",
      id: "call-1",
      name: "echo",
      args: {},
    });
    await flushMicrotasks();

    expect(errors.some((e) => e.phase === "tool")).toBe(true);
  });

  test("context.reportProgress sends a tool_call_progress frame carrying the call's session/id", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    let capturedReportProgress!: (
      progress?: number,
      message?: string
    ) => Promise<void>;
    client.registerTool({
      name: "slow",
      description: "Slow tool",
      handler: (_args, context) => {
        capturedReportProgress = context.reportProgress;
        // Never resolves: keeps this test focused on the reportProgress frame, not the
        // eventual tool_result/tool_error the invocation would otherwise also send.
        return new Promise(() => {});
      },
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;
    nativeModule.sentMessages.length = 0;

    fireMessage(nativeModule, {
      type: "tool_call",
      session_id: "session-123",
      id: "call-1",
      name: "slow",
      args: {},
    });
    await flushMicrotasks();

    await capturedReportProgress(0.5, "halfway there");

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_call_progress",
        session_id: "session-123",
        id: "call-1",
        progress: 0.5,
        message: "halfway there",
      })
    );
  });

  test("context.reportProgress with no arguments sends a bare progress frame", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    let capturedReportProgress!: (
      progress?: number,
      message?: string
    ) => Promise<void>;
    client.registerTool({
      name: "slow",
      description: "Slow tool",
      handler: (_args, context) => {
        capturedReportProgress = context.reportProgress;
        // Never resolves: keeps this test focused on the reportProgress frame, not the
        // eventual tool_result/tool_error the invocation would otherwise also send.
        return new Promise(() => {});
      },
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;
    nativeModule.sentMessages.length = 0;

    fireMessage(nativeModule, {
      type: "tool_call",
      session_id: "session-123",
      id: "call-1",
      name: "slow",
      args: {},
    });
    await flushMicrotasks();

    await capturedReportProgress();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_call_progress",
        session_id: "session-123",
        id: "call-1",
      })
    );
  });

  test("a failure to send a progress frame is reported on the unified error channel, not thrown", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    let capturedReportProgress!: (
      progress?: number,
      message?: string
    ) => Promise<void>;
    client.registerTool({
      name: "slow",
      description: "Slow tool",
      handler: (_args, context) => {
        capturedReportProgress = context.reportProgress;
        // Never resolves: keeps this test focused on the reportProgress frame, not the
        // eventual tool_result/tool_error the invocation would otherwise also send.
        return new Promise(() => {});
      },
    });

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;

    nativeModule.send = async () => {
      throw new Error("socket write failed");
    };

    const errors: CordieriteUnifiedErrorEvent[] = [];
    client.addCordieriteListener("error", (e) => errors.push(e));

    fireMessage(nativeModule, {
      type: "tool_call",
      session_id: "session-123",
      id: "call-1",
      name: "slow",
      args: {},
    });
    await flushMicrotasks();

    await capturedReportProgress(0.1);

    expect(errors.some((e) => e.phase === "tool")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// postEvent
// ---------------------------------------------------------------------------

describe("createCordieriteClient: postEvent", () => {
  test("sends an event frame while active", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    const connectPromise = client.connect(validBootstrap());
    fireMessage(nativeModule, buildAck());
    await connectPromise;
    nativeModule.sentMessages.length = 0;

    await client.postEvent("button_tapped", { id: "save" });

    expect(nativeModule.sentMessages).toHaveLength(1);
    const sent = JSON.parse(nativeModule.sentMessages[0]!) as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({
      type: "event",
      session_id: "session-123",
      name: "button_tapped",
      payload: { id: "save" },
    });
  });

  test("drops with a dev warning and does not throw when not active", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      await expect(client.postEvent("no_session")).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }

    expect(nativeModule.sentMessages).toEqual([]);
    expect(
      warnings.some((args) =>
        args.some(
          (arg) => typeof arg === "string" && arg.includes("no_session")
        )
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// destroy(): module listener cleanup (v1 defect: module listeners never removed)
// ---------------------------------------------------------------------------

describe("createCordieriteClient: destroy", () => {
  test("destroy() removes only this client's module listeners", () => {
    const nativeModule = createMockModule();
    const clientA = createCordieriteClient(nativeModule);
    const clientB = createCordieriteClient(nativeModule);

    expect(nativeModule.listeners.get("message")?.size).toBe(2);
    expect(nativeModule.listeners.get("close")?.size).toBe(2);
    expect(nativeModule.listeners.get("error")?.size).toBe(2);

    clientA.destroy();

    expect(nativeModule.listeners.get("message")?.size).toBe(1);
    expect(nativeModule.listeners.get("close")?.size).toBe(1);
    expect(nativeModule.listeners.get("error")?.size).toBe(1);

    void clientB;
  });
});
