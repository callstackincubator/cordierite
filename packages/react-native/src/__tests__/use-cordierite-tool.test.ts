import { beforeEach, describe, expect, vi, test } from "vitest";

import type { CordieriteToolRegistration } from "../Cordierite.types";
import type { CordieriteSubscription } from "../public-api";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

type EffectCleanup = (() => void) | void;
type EffectCallback = () => EffectCleanup;

/**
 * A minimal, controllable stand-in for React's `useRef`/`useEffect` that implements exactly the
 * one contract `useCordieriteTool` depends on (run the effect on the first call, and again only
 * when `deps` shallowly changes, disposing the previous effect first) -- without needing a real
 * reconciler. "react-native"'s own source cannot be parsed under a Node test runner (Flow-typed), and
 * pulling in a full React renderer just to drive one `useEffect` call is unnecessary; mocking "react"
 * itself follows the same pattern `deep-link-install.test.ts` uses for `Linking`.
 *
 * Represents a *single* component instance: each `render()` call is one re-render of that instance.
 */
const createFakeReactHost = () => {
  let ref: { current: unknown } | undefined;
  let prevDeps: readonly unknown[] | undefined;
  let hasRunOnce = false;
  let cleanup: EffectCleanup;
  let effectRunCount = 0;

  const useRef = <T>(initial: T): { current: T } => {
    ref ??= { current: initial };
    return ref as { current: T };
  };

  const useEffect = (
    effect: EffectCallback,
    deps?: readonly unknown[]
  ): void => {
    const depsChanged =
      !hasRunOnce ||
      deps === undefined ||
      prevDeps === undefined ||
      deps.length !== prevDeps.length ||
      deps.some((dep, index) => dep !== prevDeps![index]);

    if (!depsChanged) {
      return;
    }

    cleanup?.();
    hasRunOnce = true;
    prevDeps = deps;
    effectRunCount += 1;
    cleanup = effect();
  };

  return {
    useRef,
    useEffect,
    render(runHook: () => void) {
      runHook();
    },
    unmount() {
      cleanup?.();
      cleanup = undefined;
    },
    get effectRunCount() {
      return effectRunCount;
    },
  };
};

type Registration = { id: number; removed: boolean };

const makeRegisterTool = () => {
  const registrations: Registration[] = [];
  let nextId = 0;

  const registerTool = (
    _registration: CordieriteToolRegistration<undefined, undefined>
  ): CordieriteSubscription => {
    const entry: Registration = { id: nextId++, removed: false };
    registrations.push(entry);
    return {
      remove() {
        entry.removed = true;
      },
    };
  };

  return { registerTool, registrations };
};

const toolDefinition = (
  name = "t"
): CordieriteToolRegistration<undefined, undefined> => ({
  name,
  description: "test tool",
  handler: () => undefined,
});

describe("createUseCordieriteTool", () => {
  let host: ReturnType<typeof createFakeReactHost>;

  beforeEach(() => {
    host = createFakeReactHost();
    vi.resetModules();
    vi.doMock("react", () => ({
      useEffect: host.useEffect,
      useRef: host.useRef,
    }));
  });

  test("registers on mount and disposes on unmount", async () => {
    const { registerTool, registrations } = makeRegisterTool();
    const { createUseCordieriteTool } = await import("../useCordieriteTool");
    const useCordieriteTool = createUseCordieriteTool(registerTool);

    host.render(() => {
      useCordieriteTool(toolDefinition(), []);
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.removed).toBe(false);

    host.unmount();

    expect(registrations[0]?.removed).toBe(true);
  });

  test("does not re-register across re-renders with unchanged deps", async () => {
    const { registerTool, registrations } = makeRegisterTool();
    const { createUseCordieriteTool } = await import("../useCordieriteTool");
    const useCordieriteTool = createUseCordieriteTool(registerTool);

    host.render(() => useCordieriteTool(toolDefinition(), [1]));
    host.render(() => useCordieriteTool(toolDefinition(), [1]));

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.removed).toBe(false);
  });

  test("disposes the old registration and creates a new one when deps change (fast-refresh churn)", async () => {
    const { registerTool, registrations } = makeRegisterTool();
    const { createUseCordieriteTool } = await import("../useCordieriteTool");
    const useCordieriteTool = createUseCordieriteTool(registerTool);

    host.render(() => useCordieriteTool(toolDefinition(), [1]));
    host.render(() => useCordieriteTool(toolDefinition(), [2]));

    expect(registrations).toHaveLength(2);
    expect(registrations[0]?.removed).toBe(true);
    expect(registrations[1]?.removed).toBe(false);
  });

  test("re-registers on every render when deps is omitted", async () => {
    const { registerTool, registrations } = makeRegisterTool();
    const { createUseCordieriteTool } = await import("../useCordieriteTool");
    const useCordieriteTool = createUseCordieriteTool(registerTool);

    host.render(() => useCordieriteTool(toolDefinition()));
    host.render(() => useCordieriteTool(toolDefinition()));

    expect(registrations).toHaveLength(2);
    expect(registrations[0]?.removed).toBe(true);
  });

  test("a later call always sees the latest definition object, not a stale closure", async () => {
    const seen: string[] = [];
    const registerTool = (
      registration: CordieriteToolRegistration<undefined, undefined>
    ): CordieriteSubscription => {
      seen.push(registration.name);
      return { remove() {} };
    };
    const { createUseCordieriteTool } = await import("../useCordieriteTool");
    const useCordieriteTool = createUseCordieriteTool(registerTool);

    host.render(() => useCordieriteTool(toolDefinition("first"), [1]));
    host.render(() => useCordieriteTool(toolDefinition("second"), [2]));

    expect(seen).toEqual(["first", "second"]);
  });
});
