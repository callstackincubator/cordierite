import { describe, expect, test, vi } from "vitest";

import type { CordieriteRegisteredTool } from "../Cordierite.types";
import type { ClientTimerHandle, ClientTimers } from "../client/timers";
import { createToolMessageHandler } from "../client/tool-invocation";

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
