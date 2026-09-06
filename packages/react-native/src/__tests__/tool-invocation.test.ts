import { describe, expect, test, vi } from "vitest";
import { z as z3 } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { CordieriteRegisteredTool } from "../Cordierite.types";
import type { ClientTimerHandle, ClientTimers } from "../client/timers";
import { createToolMessageHandler } from "../client/tool-invocation";
import { normalizeToolSchema, toToolDescriptor } from "../schema";

/** Real timers, but exposed through the `ClientTimers` DI seam the module under test expects. */
const realTimers: ClientTimers = {
  setTimeout: (callback, ms) =>
    setTimeout(callback, ms) as unknown as ClientTimerHandle,
  clearTimeout: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
  now: () => Date.now(),
  random: () => Math.random(),
};

const SESSION_ID = "session-1";

const registerTool = (
  registry: Map<string, CordieriteRegisteredTool>,
  name: string,
  handler: CordieriteRegisteredTool["handler"],
  timeoutMs = 1000,
): void => {
  registry.set(name, {
    id: Symbol(name),
    descriptor: { name, description: "A test tool." },
    handler,
    timeoutMs,
  });
};

const createHarness = () => {
  const registry = new Map<string, CordieriteRegisteredTool>();
  const sent: Record<string, unknown>[] = [];
  const errors: unknown[] = [];

  const handlerApi = createToolMessageHandler({
    getSessionId: () => SESSION_ID,
    getRegistry: () => registry,
    sendWire: async (json) => {
      sent.push(JSON.parse(json));
    },
    timers: realTimers,
    onError: (event) => {
      errors.push(event);
    },
  });

  return { registry, sent, errors, ...handlerApi };
};

const toolCallMessage = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
) => ({
  type: "tool_call",
  session_id: SESSION_ID,
  id,
  name,
  args,
});

const toolCancelMessage = (id: string, reason = "client_cancelled") => ({
  type: "tool_cancel",
  session_id: SESSION_ID,
  id,
  reason,
});

describe("createToolMessageHandler: cancellation", () => {
  test("tool_cancel aborts the handler's signal, and an observing handler's throw is reported as tool_cancelled", async () => {
    const { registry, sent, handleMessage } = createHarness();

    let observedAborted = false;
    let resolveHandler!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    registerTool(registry, "slow", (_args, { signal }) => {
      return new Promise((_resolve, reject) => {
        resolveHandler();
        signal.addEventListener("abort", () => {
          observedAborted = true;
          reject(new Error("aborted"));
        });
      });
    });

    const callPromise = handleMessage(toolCallMessage("call-1", "slow"));
    await handlerStarted;
    await handleMessage(toolCancelMessage("call-1"));
    await callPromise;

    expect(observedAborted).toBe(true);
    expect(sent).toEqual([
      {
        type: "tool_error",
        session_id: SESSION_ID,
        id: "call-1",
        error: { type: "tool_cancelled", message: expect.any(String) },
      },
    ]);
  });

  test("a handler that ignores the signal still completes normally (backwards compatible)", async () => {
    const { registry, sent, handleMessage } = createHarness();

    let resolveHandler!: (value: undefined) => void;
    const handlerCalled = new Promise<void>((resolve) => {
      registerTool(registry, "stubborn", () => {
        resolve();
        return new Promise<undefined>((res) => {
          resolveHandler = res;
        });
      });
    });

    const callPromise = handleMessage(toolCallMessage("call-2", "stubborn"));
    await handlerCalled;
    await handleMessage(toolCancelMessage("call-2"));
    resolveHandler(undefined);
    await callPromise;

    expect(sent).toEqual([
      {
        type: "tool_result",
        session_id: SESSION_ID,
        id: "call-2",
        result: null,
      },
    ]);
  });

  test("tool_cancel for an unknown or already-finished id is a silent no-op", async () => {
    const { sent, handleMessage } = createHarness();

    await handleMessage(toolCancelMessage("call-does-not-exist"));

    expect(sent).toEqual([]);
  });

  test("abortAllInFlight aborts every currently-registered call's signal", async () => {
    const { registry, handleMessage, abortAllInFlight } = createHarness();

    const aborted: string[] = [];
    let started = 0;
    let resolveStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    for (const name of ["a", "b"]) {
      registerTool(registry, name, (_args, { signal }) => {
        return new Promise((_resolve, reject) => {
          started += 1;
          if (started === 2) {
            resolveStarted();
          }
          signal.addEventListener("abort", () => {
            aborted.push(name);
            reject(new Error("aborted"));
          });
        });
      });
    }

    const callA = handleMessage(toolCallMessage("call-a", "a"));
    const callB = handleMessage(toolCallMessage("call-b", "b"));
    await bothStarted;

    abortAllInFlight();
    await Promise.all([callA, callB]);

    expect(aborted.sort()).toEqual(["a", "b"]);
  });

  test("abortAllInFlight reports tool_cancelled (not a generic execution error) and never fires onError", async () => {
    const { registry, sent, errors, handleMessage, abortAllInFlight } = createHarness();

    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });

    registerTool(registry, "loses-transport", (_args, { signal }) => {
      return new Promise((_resolve, reject) => {
        handlerStarted();
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const callPromise = handleMessage(toolCallMessage("call-4", "loses-transport"));
    await started;

    abortAllInFlight();
    await callPromise;

    expect(sent).toEqual([
      {
        type: "tool_error",
        session_id: SESSION_ID,
        id: "call-4",
        error: { type: "tool_cancelled", message: expect.any(String) },
      },
    ]);
    // The client initiated this abort itself (transport loss) — it must not also surface it to
    // the app's own error listeners as if something unexpected happened.
    expect(errors).toEqual([]);
  });

  test("a timeout also aborts the signal, distinctly from an explicit tool_cancel", async () => {
    const { registry, sent, handleMessage } = createHarness();

    let observedAborted = false;
    registerTool(
      registry,
      "hangs",
      (_args, { signal }) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAborted = true;
            reject(new Error("aborted"));
          });
        });
      },
      10,
    );

    await handleMessage(toolCallMessage("call-3", "hangs"));
    await vi.waitFor(() => expect(observedAborted).toBe(true));

    expect(sent).toEqual([
      {
        type: "tool_error",
        session_id: SESSION_ID,
        id: "call-3",
        error: { type: "tool_timeout", message: expect.any(String) },
      },
    ]);
  });
});

describe("createToolMessageHandler: paired and raw tool schemas (issue #27)", () => {
  test("a zod 3 + zod-to-json-schema pair validates args and results end to end", async () => {
    const { registry, sent, handleMessage } = createHarness();

    const input = z3.object({ a: z3.number(), b: z3.number() });
    const output = z3.object({ total: z3.number() });
    const inputPair = normalizeToolSchema(
      { schema: input, jsonSchema: zodToJsonSchema(input) },
      "l",
    );
    const outputPair = normalizeToolSchema(
      { schema: output, jsonSchema: zodToJsonSchema(output) },
      "l",
    );

    registry.set("sum", {
      id: Symbol("sum"),
      descriptor: toToolDescriptor({
        name: "sum",
        description: "Add two numbers.",
        inputSchema: inputPair,
        outputSchema: outputPair,
      }),
      inputSchema: inputPair,
      outputSchema: outputPair,
      handler: (args) => {
        const { a, b } = args as { a: number; b: number };
        return { total: a + b };
      },
      timeoutMs: 1000,
    });

    // The descriptor the daemon would receive carries a real shape, not an empty object.
    expect(registry.get("sum")?.descriptor.input_schema).toMatchObject({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
    });

    await handleMessage(toolCallMessage("call-p1", "sum", { a: 2, b: 3 }));

    expect(sent).toEqual([
      {
        type: "tool_result",
        session_id: SESSION_ID,
        id: "call-p1",
        result: { total: 5 },
      },
    ]);
  });

  test("a paired schema still rejects bad input with tool_input_validation_error", async () => {
    const { registry, sent, handleMessage } = createHarness();

    const input = z3.object({ a: z3.number() });
    registry.set("strict", {
      id: Symbol("strict"),
      descriptor: { name: "strict", description: "d" },
      inputSchema: normalizeToolSchema(
        { schema: input, jsonSchema: zodToJsonSchema(input) },
        "l",
      ),
      handler: () => undefined,
      timeoutMs: 1000,
    });

    await handleMessage(toolCallMessage("call-p2", "strict", { a: "nope" }));

    expect(sent[0]).toMatchObject({
      type: "tool_error",
      id: "call-p2",
      error: { type: "tool_input_validation_error" },
    });
  });

  test("a raw JSON Schema tool passes args straight through, unvalidated", async () => {
    const { registry, sent, handleMessage } = createHarness();

    const seen: unknown[] = [];
    registry.set("raw", {
      id: Symbol("raw"),
      descriptor: { name: "raw", description: "d" },
      inputSchema: normalizeToolSchema(
        {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        "l",
      ),
      outputSchema: normalizeToolSchema({ type: "object" }, "l"),
      handler: (args) => {
        seen.push(args);
        return { ok: true };
      },
      timeoutMs: 1000,
    });

    // `city` is required by the schema and absent, and `extra` is not declared at all: with no
    // app-side JSON Schema validator both reach the handler verbatim.
    await handleMessage(toolCallMessage("call-r1", "raw", { extra: 1 }));

    expect(seen).toEqual([{ extra: 1 }]);
    expect(sent).toEqual([
      {
        type: "tool_result",
        session_id: SESSION_ID,
        id: "call-r1",
        result: { ok: true },
      },
    ]);
  });

  test("a raw output schema does not reject a non-matching result", async () => {
    const { registry, sent, handleMessage } = createHarness();

    registry.set("raw-out", {
      id: Symbol("raw-out"),
      descriptor: { name: "raw-out", description: "d" },
      outputSchema: normalizeToolSchema(
        { type: "object", required: ["total"] },
        "l",
      ),
      handler: () => "a string, not an object",
      timeoutMs: 1000,
    });

    await handleMessage(toolCallMessage("call-r2", "raw-out"));

    expect(sent).toEqual([
      {
        type: "tool_result",
        session_id: SESSION_ID,
        id: "call-r2",
        result: "a string, not an object",
      },
    ]);
  });
});
