import { beforeEach, describe, expect, vi, test } from "vitest";

import type {
  CordieriteRuntimeSchema,
  CordieriteToolRegistration,
} from "../Cordierite.types";
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
    deps?: readonly unknown[],
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

  const registerTool = <
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined,
  >(
    _registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
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
  name = "t",
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
    const registerTool = <
      TInputSchema extends CordieriteRuntimeSchema | undefined,
      TOutputSchema extends CordieriteRuntimeSchema | undefined,
    >(
      registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
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

  describe("options.enabled", () => {
    test("defaults to enabled: registers on mount", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(registerTool);

      host.render(() => useCordieriteTool(toolDefinition(), []));

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.removed).toBe(false);
    });

    test("enabled: false never registers", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(registerTool);

      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: false }),
      );

      expect(registrations).toHaveLength(0);
    });

    test("true -> false removes the registration and leaks nothing", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(registerTool);

      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: true }),
      );
      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.removed).toBe(false);

      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: false }),
      );

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.removed).toBe(true);
    });

    test("false -> true registers", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(registerTool);

      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: false }),
      );
      expect(registrations).toHaveLength(0);

      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: true }),
      );

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.removed).toBe(false);
    });

    test("toggling twice (true -> false -> true) leaves exactly one live registration", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(registerTool);

      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: true }),
      );
      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: false }),
      );
      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: true }),
      );

      expect(registrations).toHaveLength(2);
      expect(registrations[0]?.removed).toBe(true);
      expect(registrations[1]?.removed).toBe(false);
    });

    test("unmounting while disabled is a no-op — nothing was registered, so there is nothing to remove", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(registerTool);

      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: false }),
      );
      expect(registrations).toHaveLength(0);

      expect(() => host.unmount()).not.toThrow();
      expect(registrations).toHaveLength(0);
    });

    test("toggling enabled re-runs the effect even when deps is otherwise omitted", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(registerTool);

      host.render(() =>
        useCordieriteTool(toolDefinition(), undefined, { enabled: true }),
      );
      expect(registrations).toHaveLength(1);

      host.render(() =>
        useCordieriteTool(toolDefinition(), undefined, { enabled: false }),
      );

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.removed).toBe(true);
    });
  });

  describe("identity, not name: a stale disposer never removes a newer registration under the same name", () => {
    /**
     * Mirrors `client/registry.ts`'s actual contract exactly (Map keyed by tool name, disposer
     * compared by a per-call identity, not by name) — a fake with array-based, name-agnostic
     * bookkeeping would not exercise the bug class this guards against (a v1 defect: a stale
     * disposer from an earlier `registerTool("foo", …)` call deleting a newer registration under
     * the same name). See `client/registry.ts:44-46` and `client.test.ts`'s equivalent coverage
     * at the registry layer; this test exercises the same contract through two independent
     * `useCordieriteTool` hook instances instead of calling the registry directly.
     */
    const createFakeIdentityRegistry = () => {
      const entries = new Map<string, symbol>();
      const deltas: { op: "upsert" | "remove"; name: string }[] = [];

      const registerTool = <
        TInputSchema extends CordieriteRuntimeSchema | undefined,
        TOutputSchema extends CordieriteRuntimeSchema | undefined,
      >(
        registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
      ): CordieriteSubscription => {
        const id = Symbol(registration.name);
        entries.set(registration.name, id);
        deltas.push({ op: "upsert", name: registration.name });
        return {
          remove: () => {
            if (entries.get(registration.name) !== id) {
              // Stale disposer: a newer registration under the same name replaced this one.
              return;
            }
            entries.delete(registration.name);
            deltas.push({ op: "remove", name: registration.name });
          },
        };
      };

      return { registerTool, entries, deltas };
    };

    test("disabling hook A never removes hook B's still-active registration under the same name", async () => {
      const registry = createFakeIdentityRegistry();
      const hostA = createFakeReactHost();
      const hostB = createFakeReactHost();

      vi.resetModules();
      vi.doMock("react", () => ({
        useEffect: hostA.useEffect,
        useRef: hostA.useRef,
      }));
      const { createUseCordieriteTool: createA } =
        await import("../useCordieriteTool");
      const useCordieriteToolA = createA(registry.registerTool);
      hostA.render(() =>
        useCordieriteToolA(toolDefinition("shared"), [], { enabled: true }),
      );

      vi.resetModules();
      vi.doMock("react", () => ({
        useEffect: hostB.useEffect,
        useRef: hostB.useRef,
      }));
      const { createUseCordieriteTool: createB } =
        await import("../useCordieriteTool");
      const useCordieriteToolB = createB(registry.registerTool);
      hostB.render(() =>
        useCordieriteToolB(toolDefinition("shared"), [], { enabled: true }),
      );

      // B's registration overwrote A's in the registry (real registry semantics: one entry per
      // name), so only B's is live even though A's hook instance still believes it owns one.
      expect(registry.entries.size).toBe(1);

      // Disabling A fires A's now-stale disposer. It must be a no-op: B's live registration
      // under the same name must survive.
      hostA.render(() =>
        useCordieriteToolA(toolDefinition("shared"), [], { enabled: false }),
      );

      expect(registry.entries.size).toBe(1);
      expect(registry.deltas.at(-1)).toEqual({ op: "upsert", name: "shared" });

      // Disabling B removes the real, current registration.
      hostB.render(() =>
        useCordieriteToolB(toolDefinition("shared"), [], { enabled: false }),
      );

      expect(registry.entries.size).toBe(0);
      expect(registry.deltas.at(-1)).toEqual({ op: "remove", name: "shared" });
    });
  });
});
