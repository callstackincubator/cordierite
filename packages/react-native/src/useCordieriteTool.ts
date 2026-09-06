import type { ToolSchemaDescriptor } from "@cordierite/shared";
import { useEffect, useRef, type DependencyList } from "react";

import type {
  CordieriteRuntimeSchema,
  CordieriteToolHandler,
  CordieriteToolRegistration,
  InferToolArgs,
  InferToolResult,
} from "./Cordierite.types";
import type { CordieriteSubscription } from "./public-api";

type ToolRegistrar = <
  TInputSchema extends CordieriteRuntimeSchema | undefined,
  TOutputSchema extends CordieriteRuntimeSchema | undefined,
>(
  registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
) => CordieriteSubscription;

/** Options for `useCordieriteTool`. */
export type UseCordieriteToolOptions = {
  /**
   * Whether the tool should be registered. Defaults to `true`. `false` never registers (and
   * removes any existing registration owned by this hook instance), so this is the supported way
   * to gate a tool by build variant without violating the rules of hooks — put the condition in
   * the argument instead of wrapping the hook call itself, e.g.
   * `{ enabled: process.env.EXPO_PUBLIC_CORDIERITE_TOOLS === "full" }`. See `docs/SECURITY.md`'s
   * "Gating a tool by build variant" section for the recommended predicate and why `__DEV__`
   * is the wrong default for anything but genuinely debug-only tools.
   */
  enabled?: boolean;
};

/** Shape of `schema.ts`'s `exportToolSchemaForKey`, injected rather than imported (see below). */
type ToolSchemaExporter = (
  schema: CordieriteRuntimeSchema,
  mode: "input" | "output",
) => ToolSchemaDescriptor | undefined;

/** Options for `createUseCordieriteTool` (library-internal, not part of the public API). */
export type CreateUseCordieriteToolOptions = {
  /**
   * JSON Schema exporter used to derive the registration key when the caller omits `deps`.
   * Injected by the real (`.`) entry and deliberately omitted by the inert (`./noop`) one: with a
   * registrar that registers nothing, deriving a key would export JSON Schema on every render to
   * decide how often to re-run a no-op, and a static import would pull `schema.ts` into a bundle
   * whose whole purpose is to carry no Cordierite work. Without it the effect keys off `enabled`
   * alone; the returned hook's signature, arity and observable behavior are identical either way
   * (ARCHITECTURE.md §11).
   */
  exportSchema?: ToolSchemaExporter;
};

/**
 * Per-hook, per-slot memo for the derived registration key: the schema object last seen and the
 * key it produced. Identity is checked first, so a hoisted or memoized schema never re-exports; a
 * schema rebuilt inline on every render exports once per render (what an unconditional
 * re-registration already cost) but only changes the key when its *shape* changed.
 */
type SchemaKeyMemo = {
  schema: CordieriteRuntimeSchema | undefined;
  key: string | undefined;
  /** Bumped for each new *unexportable* schema object, which has no shape to compare by value. */
  shapelessSeq: number;
};

const createSchemaKeyMemo = (): SchemaKeyMemo => ({
  schema: undefined,
  key: undefined,
  shapelessSeq: 0,
});

const schemaKey = (
  schema: CordieriteRuntimeSchema | undefined,
  mode: "input" | "output",
  exportSchema: ToolSchemaExporter,
  memo: SchemaKeyMemo,
): string | undefined => {
  if (schema === memo.schema) {
    return memo.key;
  }

  let key: string | undefined;
  if (schema === undefined) {
    key = undefined;
  } else {
    // `exportToolSchemaForKey` returns `undefined` for a schema that does not export JSON Schema
    // (zod 3, plain valibot) or that is not a valid schema at all. It never throws or warns: this
    // runs during render, and reporting a shapeless or invalid schema belongs to the registration
    // path, not to key derivation.
    const exported = exportSchema(schema, mode);
    if (exported === undefined) {
      // No shape to compare by value, and "exports nothing" must not collide with "no schema at
      // all" -- the registry entry still holds the object and validates against it, and
      // `tool-invocation.ts` keys its "must not return a result when outputSchema is omitted" rule
      // on the entry's `outputSchema` being present. So fall back to identity: a new unexportable
      // schema object always produces a new key, which does mean an unexportable schema rebuilt
      // inline every render re-registers every render (exactly what it did before). Hoist it, or
      // move to zod v4, whose built-in exporter puts it back on the by-shape path.
      memo.shapelessSeq += 1;
      // Cannot collide with the branch below: `JSON.stringify` of an exported schema is always a
      // JSON object literal, so it always starts with `{`.
      key = `shapeless:${memo.shapelessSeq}`;
    } else {
      key = JSON.stringify(exported);
    }
  }

  memo.schema = schema;
  memo.key = key;

  return key;
};

/**
 * Builds `useCordieriteTool` on top of a `registerTool` implementation. Both the real (`.`) and
 * inert (`./noop`) entries call this with their own `registerTool`, so the hook's remount/dependency
 * behavior can never drift between the two (ARCHITECTURE.md §11).
 */
export function createUseCordieriteTool(
  registerTool: ToolRegistrar,
  { exportSchema }: CreateUseCordieriteToolOptions = {},
) {
  /**
   * `useEffect` wrapper around `registerTool` that registers **once per mount** and re-registers
   * only when something that changes the registry entry changed — `name`, `description`, the
   * exported input/output JSON Schemas, `annotations`, `timeoutMs`, or `options.enabled`. Omitting
   * `deps` is therefore the correct, cheap default: re-rendering the hosting component does not
   * produce `tool_registry_delta` traffic or agent-side `tools/list_changed` notifications.
   * (`timeoutMs` is app-side only — the daemon never sees it — but it is part of the entry, so a
   * change to it has to reach the registry.)
   *
   * Handler freshness: the registered handler is a stable wrapper that forwards to
   * `definitionRef.current.handler`, so a handler closing over component state always sees the
   * latest render's values on the next call, with no re-registration and no ref workarounds.
   *
   * `deps` remains as an advanced, explicit override with `useEffect`'s own semantics (it fully
   * replaces the derived key; `enabled` is still appended). Pass it consistently — alternating
   * between passing `deps` and omitting it changes the dependency-array length between renders,
   * which React warns about, exactly as it does for a hand-written `useEffect`.
   *
   * Two consequences of registering once, both of which `deps` opts out of:
   *
   * - The registry keeps the schema objects from the most recent registration, so a schema
   *   replaced by an identity-different one that exports the *same* JSON Schema keeps validating
   *   against the earlier object. That only matters for a validation rule JSON Schema cannot
   *   express *and* that closes over changing state (a `.refine()` over component state, say).
   * - Two mounted hooks registering the same tool name: the later registration wins (with the
   *   registry's dev warning), and when it unmounts the earlier hook no longer re-claims the name
   *   on its next render — the name stays unregistered until that hook re-registers for its own
   *   reasons. Duplicate names were never a supported configuration; this makes the existing dev
   *   warning the thing to fix rather than a race to lose.
   *
   * Re-registration relies on the registry's identity-safe disposer, so remount / Fast Refresh
   * churn — and toggling `enabled` — never leaks a stale registration or clobbers a newer one
   * under the same tool name.
   */
  return function useCordieriteTool<
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined,
  >(
    definition: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
    deps?: DependencyList,
    options?: UseCordieriteToolOptions,
  ): void {
    // Keeps the latest definition available to the effect and to the stable handler wrapper
    // without making it part of the effect's own dependency list.
    const definitionRef = useRef(definition);
    definitionRef.current = definition;

    // Created once per hook instance and never replaced, so the registered handler's identity is
    // stable across renders while the handler it forwards to is always the latest one.
    const stableHandlerRef = useRef<
      CordieriteToolHandler<
        InferToolArgs<TInputSchema>,
        InferToolResult<TOutputSchema>
      >
    >((args, context) => definitionRef.current.handler(args, context));

    const schemaKeyMemosRef = useRef<{
      input: SchemaKeyMemo;
      output: SchemaKeyMemo;
    }>({ input: createSchemaKeyMemo(), output: createSchemaKeyMemo() });

    const enabled = options?.enabled ?? true;

    // `null` is not a legal `DependencyList`, but untyped JS callers pass it, and the previous
    // truthiness check treated it exactly like an omitted argument. Keep doing that rather than
    // spreading it.
    const hasDeps = deps !== undefined && deps !== null;

    // Which branch the dependency array takes -- deliberately independent of `enabled`, so the
    // array's length never changes between renders. The key is only derived when `deps` is
    // omitted: a caller who passed `deps` opted out of it entirely and should not pay for a JSON
    // Schema export they did not ask for.
    const derivesKey = !hasDeps && exportSchema !== undefined;

    // Whether to actually do that work this render. A disabled tool never reaches `registerTool`,
    // so there is nothing for a key to describe: leave every entry `undefined` and skip the
    // export. Re-enabling always re-runs the effect anyway, because `enabled` is itself a
    // dependency, and the memos are untouched meanwhile so an unchanged schema still hits them.
    const derivesKeyNow = derivesKey && enabled;
    const inputSchemaKey = derivesKeyNow
      ? schemaKey(
          definition.inputSchema,
          "input",
          exportSchema,
          schemaKeyMemosRef.current.input,
        )
      : undefined;
    const outputSchemaKey = derivesKeyNow
      ? schemaKey(
          definition.outputSchema,
          "output",
          exportSchema,
          schemaKeyMemosRef.current.output,
        )
      : undefined;
    const annotationsKey =
      derivesKeyNow && definition.annotations !== undefined
        ? JSON.stringify(definition.annotations)
        : undefined;

    useEffect(
      () => {
        if (!enabled) {
          // No registration this effect run means nothing to leak and nothing for the cleanup
          // below to remove — the disabled state simply skips `registerTool` entirely.
          return;
        }
        // The caller's own handler is never registered: the stable wrapper is, so re-renders that
        // only change the closure do not need (and do not cause) a re-registration.
        const registration = registerTool({
          ...definitionRef.current,
          handler: stableHandlerRef.current,
        });
        return () => {
          registration.remove();
        };
      },
      // Each branch has a fixed length across renders (caller-supplied `deps` mirrors
      // `useEffect`'s own contract); `enabled` is appended explicitly in all three so toggling it
      // re-runs the effect. The dependency list is built by hand on purpose, so do not let an
      // `exhaustive-deps` autofix "complete" it.
      hasDeps
        ? [...deps, enabled]
        : derivesKey
          ? [
              definition.name,
              definition.description,
              definition.timeoutMs,
              annotationsKey,
              inputSchemaKey,
              outputSchemaKey,
              enabled,
            ]
          : [enabled],
    );
  };
}
