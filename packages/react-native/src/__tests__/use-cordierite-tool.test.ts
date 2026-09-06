import { beforeEach, describe, expect, vi, test } from "vitest";

import type {
  CordieriteRuntimeSchema,
  CordieriteToolExecutionContext,
  CordieriteToolHandler,
  CordieriteToolRegistration,
} from "../Cordierite.types";
import type { CordieriteSubscription } from "../public-api";
import { exportToolSchemaForKey } from "../schema";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

type EffectCleanup = (() => void) | void;
type EffectCallback = () => EffectCleanup;

/**
 * A minimal, controllable stand-in for React's `useRef`/`useEffect` that implements exactly the
 * one contract `useCordieriteTool` depends on (stable ref slots in call order, run the effect on
 * the first call and again only when `deps` shallowly changes, disposing the previous effect
 * first) -- without needing a real reconciler. "react-native"'s own source cannot be parsed under a
 * Node test runner (Flow-typed), and pulling in a full React renderer just to drive one `useEffect`
 * call is unnecessary; mocking "react" itself follows the same pattern `deep-link-install.test.ts`
 * uses for `Linking`.
 *
 * Represents a *single* component instance: each `render()` call is one re-render of that instance.
 */
const createFakeReactHost = () => {
  // Ref slots are keyed by call order within a render, exactly as React keys its own hook state --
  // the hook calls `useRef` more than once (latest definition, stable handler wrapper, schema-key
  // memos), so a single shared slot would alias them together.
  const refs: { current: unknown }[] = [];
  let refCursor = 0;
  let prevDeps: readonly unknown[] | undefined;
  let hasRunOnce = false;
  let cleanup: EffectCleanup;

  const useRef = <T>(initial: T): { current: T } => {
    const index = refCursor;
    refCursor += 1;
    refs[index] ??= { current: initial };
    return refs[index] as { current: T };
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
    cleanup = effect();
  };

  return {
    useRef,
    useEffect,
    render(runHook: () => void) {
      refCursor = 0;
      runHook();
    },
    unmount() {
      cleanup?.();
      cleanup = undefined;
    },
  };
};

type Registration = {
  id: number;
  removed: boolean;
  name: string;
  description: string;
  /** The handler the hook actually registered (the stable wrapper, not the caller's closure). */
  handler: CordieriteToolHandler;
  /** What tool-invocation's "must not return a result when outputSchema is omitted" rule keys on. */
  hasOutputSchema: boolean;
};

const makeRegisterTool = () => {
  const registrations: Registration[] = [];
  let nextId = 0;

  const registerTool = <
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined,
  >(
    registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
  ): CordieriteSubscription => {
    const entry: Registration = {
      id: nextId++,
      removed: false,
      name: registration.name,
      description: registration.description,
      handler: registration.handler as CordieriteToolHandler,
      hasOutputSchema: registration.outputSchema !== undefined,
    };
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

/**
 * What the real (`.`) entry passes: the JSON Schema exporter that makes the derived registration
 * key possible. The inert (`./noop`) entry deliberately passes nothing -- covered separately below.
 */
const realEntryOptions = { exportSchema: exportToolSchemaForKey };

/** Enough of an execution context to invoke a registered handler that ignores it. */
const fakeContext = {} as CordieriteToolExecutionContext;

/**
 * A Standard Schema whose JSON Schema exporter returns `shape` -- the shape (not the object
 * identity) is what the daemon observes, so it is what the derived registration key compares.
 */
const schemaExporting = (
  shape: Record<string, unknown>,
): CordieriteRuntimeSchema =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => shape,
        output: () => shape,
      },
    },
  }) as unknown as CordieriteRuntimeSchema;

/** A Standard Schema with no JSON Schema exporter -- the zod 3 / plain valibot shape. */
const shapelessSchema = (): CordieriteRuntimeSchema =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
    },
  }) as unknown as CordieriteRuntimeSchema;

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
    const useCordieriteTool = createUseCordieriteTool(
      registerTool,
      realEntryOptions,
    );

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
    const useCordieriteTool = createUseCordieriteTool(
      registerTool,
      realEntryOptions,
    );

    host.render(() => useCordieriteTool(toolDefinition(), [1]));
    host.render(() => useCordieriteTool(toolDefinition(), [1]));

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.removed).toBe(false);
  });

  test("disposes the old registration and creates a new one when deps change (fast-refresh churn)", async () => {
    const { registerTool, registrations } = makeRegisterTool();
    const { createUseCordieriteTool } = await import("../useCordieriteTool");
    const useCordieriteTool = createUseCordieriteTool(
      registerTool,
      realEntryOptions,
    );

    host.render(() => useCordieriteTool(toolDefinition(), [1]));
    host.render(() => useCordieriteTool(toolDefinition(), [2]));

    expect(registrations).toHaveLength(2);
    expect(registrations[0]?.removed).toBe(true);
    expect(registrations[1]?.removed).toBe(false);
  });

  describe("derived registration key (deps omitted)", () => {
    test("N re-renders with an unchanged definition produce exactly one registration and no removals", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      // A fresh definition object (and a fresh handler closure) per render, which is what an
      // inline `useCordieriteTool({ ... })` call inside a component body produces.
      host.render(() => useCordieriteTool(toolDefinition()));
      host.render(() => useCordieriteTool(toolDefinition()));
      host.render(() => useCordieriteTool(toolDefinition()));

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.removed).toBe(false);
    });

    test("changing description re-registers (remove + upsert)", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      host.render(() =>
        useCordieriteTool({ ...toolDefinition(), description: "before" }),
      );
      host.render(() =>
        useCordieriteTool({ ...toolDefinition(), description: "after" }),
      );

      expect(registrations).toHaveLength(2);
      expect(registrations[0]?.removed).toBe(true);
      expect(registrations[1]?.removed).toBe(false);
      expect(registrations.map((entry) => entry.description)).toEqual([
        "before",
        "after",
      ]);
    });

    test("changing annotations or timeoutMs re-registers", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      host.render(() =>
        useCordieriteTool({
          ...toolDefinition(),
          annotations: { readOnlyHint: true },
          timeoutMs: 1_000,
        }),
      );
      // Equal-by-value annotations, new object: no re-registration.
      host.render(() =>
        useCordieriteTool({
          ...toolDefinition(),
          annotations: { readOnlyHint: true },
          timeoutMs: 1_000,
        }),
      );
      expect(registrations).toHaveLength(1);

      host.render(() =>
        useCordieriteTool({
          ...toolDefinition(),
          annotations: { readOnlyHint: false },
          timeoutMs: 1_000,
        }),
      );
      expect(registrations).toHaveLength(2);

      host.render(() =>
        useCordieriteTool({
          ...toolDefinition(),
          annotations: { readOnlyHint: false },
          timeoutMs: 2_000,
        }),
      );
      expect(registrations).toHaveLength(3);
      expect(registrations[0]?.removed).toBe(true);
      expect(registrations[1]?.removed).toBe(true);
      expect(registrations[2]?.removed).toBe(false);
    });

    test("a handler closing over changed state does not re-register, and the next call sees the new value", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      // Stands in for component state: each render closes over a different value.
      let state = 1;
      const renderWithState = () =>
        host.render(() =>
          useCordieriteTool({
            name: "t",
            description: "test tool",
            handler: () => state,
          }),
        );

      renderWithState();
      expect(registrations).toHaveLength(1);
      expect(await registrations[0]?.handler(undefined, fakeContext)).toBe(1);

      state = 2;
      renderWithState();

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.removed).toBe(false);
      expect(await registrations[0]?.handler(undefined, fakeContext)).toBe(2);
    });

    test("an inline schema rebuilt each render with an equal shape does not re-register", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      const renderWithShape = (shape: Record<string, unknown>) =>
        host.render(() =>
          useCordieriteTool({
            name: "t",
            description: "test tool",
            // A brand-new schema object every render, as `z.object({ ... })` written inline in a
            // component body produces.
            inputSchema: schemaExporting(shape),
            handler: () => undefined,
          }),
        );

      renderWithShape({
        type: "object",
        properties: { a: { type: "number" } },
      });
      renderWithShape({
        type: "object",
        properties: { a: { type: "number" } },
      });

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.removed).toBe(false);

      renderWithShape({
        type: "object",
        properties: { a: { type: "string" } },
      });

      expect(registrations).toHaveLength(2);
      expect(registrations[0]?.removed).toBe(true);
      expect(registrations[1]?.removed).toBe(false);
    });

    test("a hoisted schema kept by identity re-exports nothing and never re-registers", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      let exportCount = 0;
      const shape = { type: "object" as const };
      const hoisted = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            input: () => {
              exportCount += 1;
              return shape;
            },
            output: () => shape,
          },
        },
      } as unknown as CordieriteRuntimeSchema;

      const render = () =>
        host.render(() =>
          useCordieriteTool({
            name: "t",
            description: "test tool",
            inputSchema: hoisted,
            handler: () => undefined,
          }),
        );

      render();
      render();
      render();

      expect(registrations).toHaveLength(1);
      expect(exportCount).toBe(1);
    });

    test("changing name re-registers under the new name", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      host.render(() => useCordieriteTool(toolDefinition("before")));
      host.render(() => useCordieriteTool(toolDefinition("after")));

      expect(registrations.map((entry) => entry.name)).toEqual([
        "before",
        "after",
      ]);
      expect(registrations[0]?.removed).toBe(true);
      expect(registrations[1]?.removed).toBe(false);
    });

    test("changing the output schema's shape re-registers", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      const renderWithShape = (shape: Record<string, unknown>) =>
        host.render(() =>
          useCordieriteTool({
            name: "t",
            description: "test tool",
            outputSchema: schemaExporting(shape),
            handler: () => undefined,
          }),
        );

      renderWithShape({
        type: "object",
        properties: { total: { type: "number" } },
      });
      renderWithShape({
        type: "object",
        properties: { total: { type: "number" } },
      });
      expect(registrations).toHaveLength(1);

      renderWithShape({
        type: "object",
        properties: { total: { type: "string" } },
      });

      expect(registrations).toHaveLength(2);
      expect(registrations[0]?.removed).toBe(true);
    });

    test("a schema that exports no JSON Schema still re-registers when it is added, swapped or removed", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      // "exports nothing" and "there is no schema" must not collapse to the same key: the registry
      // entry still holds the object and validates against it, and `tool-invocation.ts` rejects a
      // returned result when the entry has no `outputSchema`.
      let outputSchema: CordieriteRuntimeSchema | undefined;
      const render = () =>
        host.render(() =>
          useCordieriteTool({
            name: "t",
            description: "test tool",
            outputSchema,
            handler: () => undefined,
          }),
        );

      render();
      outputSchema = shapelessSchema();
      render();
      // A different unexportable schema object: nothing to compare by value, so identity decides.
      outputSchema = shapelessSchema();
      render();
      outputSchema = undefined;
      render();

      expect(registrations).toHaveLength(4);
      expect(registrations.map((entry) => entry.hasOutputSchema)).toEqual([
        false,
        true,
        true,
        false,
      ]);
      expect(registrations.at(-1)?.removed).toBe(false);
    });

    test("an unchanged unexportable schema kept by identity does not re-register", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      const hoisted = shapelessSchema();
      const render = () =>
        host.render(() =>
          useCordieriteTool({
            name: "t",
            description: "test tool",
            inputSchema: hoisted,
            handler: () => undefined,
          }),
        );

      render();
      render();
      render();

      expect(registrations).toHaveLength(1);
    });

    test("a null deps argument (untyped JS callers) behaves like an omitted one", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      const nullDeps = null as unknown as undefined;

      host.render(() => useCordieriteTool(toolDefinition(), nullDeps));
      host.render(() => useCordieriteTool(toolDefinition(), nullDeps));
      expect(registrations).toHaveLength(1);

      host.render(() =>
        useCordieriteTool(
          { ...toolDefinition(), description: "changed" },
          nullDeps,
        ),
      );

      expect(registrations).toHaveLength(2);
    });
  });

  test("caller-supplied deps override the derived key entirely", async () => {
    const { registerTool, registrations } = makeRegisterTool();
    const { createUseCordieriteTool } = await import("../useCordieriteTool");
    const useCordieriteTool = createUseCordieriteTool(
      registerTool,
      realEntryOptions,
    );

    // `[]` means "register once and never again" -- a description change is deliberately ignored.
    host.render(() =>
      useCordieriteTool({ ...toolDefinition(), description: "before" }, []),
    );
    host.render(() =>
      useCordieriteTool({ ...toolDefinition(), description: "after" }, []),
    );

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.description).toBe("before");
  });

  describe("inert entry: no JSON Schema exporter injected", () => {
    /**
     * `./noop` builds the hook without an exporter, so the effect keys off `enabled` alone. Nothing
     * is observable through its no-op registrar, and it must never run a JSON Schema export to
     * decide how often to re-run a no-op.
     */
    test("never exports JSON Schema and never re-registers on a descriptor change", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(registerTool);

      let exportCount = 0;
      const countingSchema = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            input: () => {
              exportCount += 1;
              return { type: "object" };
            },
            output: () => ({ type: "object" }),
          },
        },
      } as unknown as CordieriteRuntimeSchema;

      const renderWithDescription = (description: string) =>
        host.render(() =>
          useCordieriteTool({
            name: "t",
            description,
            inputSchema: countingSchema,
            handler: () => undefined,
          }),
        );

      renderWithDescription("before");
      renderWithDescription("after");

      expect(registrations).toHaveLength(1);
      expect(exportCount).toBe(0);
    });

    test("still honours options.enabled", async () => {
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
    const useCordieriteTool = createUseCordieriteTool(
      registerTool,
      realEntryOptions,
    );

    host.render(() => useCordieriteTool(toolDefinition("first"), [1]));
    host.render(() => useCordieriteTool(toolDefinition("second"), [2]));

    expect(seen).toEqual(["first", "second"]);
  });

  describe("options.enabled", () => {
    test("defaults to enabled: registers on mount", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      host.render(() => useCordieriteTool(toolDefinition(), []));

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.removed).toBe(false);
    });

    test("enabled: false never registers", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: false }),
      );

      expect(registrations).toHaveLength(0);
    });

    test("true -> false removes the registration and leaks nothing", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

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
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

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
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

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

    test("a disabled hook never exports JSON Schema, however often it re-renders", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      // A disabled tool never reaches `registerTool`, so there is nothing for a registration key
      // to describe -- deriving one would export JSON Schema every render for no reason.
      let exportCount = 0;
      const render = () =>
        host.render(() =>
          useCordieriteTool(
            {
              name: "t",
              description: "test tool",
              // Rebuilt inline every render, so identity never hits the memo.
              inputSchema: {
                "~standard": {
                  version: 1,
                  vendor: "test",
                  validate: (value: unknown) => ({ value }),
                  jsonSchema: {
                    input: () => {
                      exportCount += 1;
                      return { type: "object" };
                    },
                    output: () => ({ type: "object" }),
                  },
                },
              } as unknown as CordieriteRuntimeSchema,
              handler: () => undefined,
            },
            undefined,
            { enabled: false },
          ),
        );

      render();
      render();
      render();

      expect(registrations).toHaveLength(0);
      expect(exportCount).toBe(0);
    });

    test("unmounting while disabled is a no-op — nothing was registered, so there is nothing to remove", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

      host.render(() =>
        useCordieriteTool(toolDefinition(), [], { enabled: false }),
      );
      expect(registrations).toHaveLength(0);

      expect(() => host.unmount()).not.toThrow();
      expect(registrations).toHaveLength(0);
    });

    test("toggling enabled re-runs the effect even when deps is omitted", async () => {
      const { registerTool, registrations } = makeRegisterTool();
      const { createUseCordieriteTool } = await import("../useCordieriteTool");
      const useCordieriteTool = createUseCordieriteTool(
        registerTool,
        realEntryOptions,
      );

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
      const useCordieriteToolA = createA(
        registry.registerTool,
        realEntryOptions,
      );
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
      const useCordieriteToolB = createB(
        registry.registerTool,
        realEntryOptions,
      );
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
