import { useEffect, useRef, type DependencyList } from "react";

import type {
  CordieriteRuntimeSchema,
  CordieriteToolHandler,
  CordieriteToolRegistration,
  InferToolArgs,
  InferToolResult,
} from "./Cordierite.types";
import type { CordieriteSubscription } from "./public-api";
import { exportToolSchema } from "./schema";

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
   * `{ enabled: process.env.EXPO_PUBLIC_CORDIERITE_TOOLS === "full" }`. See the package README's
   * "Define tools in app startup code" section for the recommended predicate and why `__DEV__`
   * is the wrong default for anything but genuinely debug-only tools.
   */
  enabled?: boolean;
};

/**
 * Per-hook, per-slot memo for the derived registration key: the schema object last seen and the
 * JSON Schema string it exported to. Identity is checked first, so a hoisted or memoized schema
 * never re-exports; a schema rebuilt inline on every render exports once per render (what an
 * unconditional re-registration already cost) but only changes the key when its *shape* changed.
 */
type SchemaKeyMemo = {
  schema: CordieriteRuntimeSchema | undefined;
  exported: string | undefined;
};

const createSchemaKeyMemo = (): SchemaKeyMemo => ({
  schema: undefined,
  exported: undefined,
});

const schemaKey = (
  schema: CordieriteRuntimeSchema | undefined,
  mode: "input" | "output",
  memo: SchemaKeyMemo,
): string | undefined => {
  if (schema === memo.schema) {
    return memo.exported;
  }

  // `exportToolSchema` already returns `undefined` for a schema without a JSON Schema exporter
  // (zod 3, plain valibot), which is exactly what the daemon would observe for it. The tool name
  // is deliberately not passed: this runs during render, and the "shapeless tool" dev warning
  // belongs to the registration path, not to key derivation.
  const exported =
    schema === undefined
      ? undefined
      : JSON.stringify(exportToolSchema(schema, mode));

  memo.schema = schema;
  memo.exported = exported;

  return exported;
};

/**
 * Builds `useCordieriteTool` on top of a `registerTool` implementation. Both the real (`.`) and
 * inert (`./noop`) entries call this with their own `registerTool`, so the hook's remount/dependency
 * behavior can never drift between the two (ARCHITECTURE.md §11).
 */
export function createUseCordieriteTool(registerTool: ToolRegistrar) {
  /**
   * `useEffect` wrapper around `registerTool` that registers **once per mount** and re-registers
   * only when something the daemon can actually observe changed — `name`, `description`, the
   * exported input/output JSON Schemas, `annotations`, `timeoutMs`, or `options.enabled`. Omitting
   * `deps` is therefore the correct, cheap default: re-rendering the hosting component does not
   * produce `tool_registry_delta` traffic or agent-side `tools/list_changed` notifications.
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

    // Only derived when `deps` is omitted: a caller who passed `deps` opted out of the derived key
    // entirely and should not pay for a JSON Schema export they did not ask for.
    const derivesKey = deps === undefined;
    const inputSchemaKey = derivesKey
      ? schemaKey(
          definition.inputSchema,
          "input",
          schemaKeyMemosRef.current.input,
        )
      : undefined;
    const outputSchemaKey = derivesKey
      ? schemaKey(
          definition.outputSchema,
          "output",
          schemaKeyMemosRef.current.output,
        )
      : undefined;
    const annotationsKey =
      derivesKey && definition.annotations !== undefined
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
        // The derived branch has a fixed length (7). `deps`, when provided, is caller-controlled
        // (mirrors `useEffect`'s own contract); `enabled` is appended explicitly in both branches
        // so toggling it re-runs the effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      derivesKey
        ? [
            definition.name,
            definition.description,
            definition.timeoutMs,
            annotationsKey,
            inputSchemaKey,
            outputSchemaKey,
            enabled,
          ]
        : [...(deps as DependencyList), enabled],
    );
  };
}
