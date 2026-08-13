import { useEffect, useRef, type DependencyList } from "react";

import type {
  CordieriteRuntimeSchema,
  CordieriteToolRegistration,
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
   * `{ enabled: process.env.EXPO_PUBLIC_CORDIERITE_TOOLS === "full" }`. See the package README's
   * "Define tools in app startup code" section for the recommended predicate and why `__DEV__`
   * is the wrong default for anything but genuinely debug-only tools.
   */
  enabled?: boolean;
};

/**
 * Builds `useCordieriteTool` on top of a `registerTool` implementation. Both the real (`.`) and
 * inert (`./noop`) entries call this with their own `registerTool`, so the hook's remount/dependency
 * behavior can never drift between the two (ARCHITECTURE.md §11).
 */
export function createUseCordieriteTool(registerTool: ToolRegistrar) {
  /**
   * `useEffect` wrapper around `registerTool`: registers on mount and whenever `deps` (or
   * `options.enabled`) changes, disposing the previous registration first. Relies on the
   * registry's identity-safe disposer so remount / fast-refresh churn — and toggling `enabled`
   * — never leaks a stale registration or clobbers a newer one under the same tool name.
   */
  return function useCordieriteTool<
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined,
  >(
    definition: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
    deps?: DependencyList,
    options?: UseCordieriteToolOptions,
  ): void {
    // Keeps the latest definition available to the effect without making it part of the effect's
    // own dependency list — callers control re-registration explicitly via `deps`, matching
    // `registerTool`'s own explicit-identity contract rather than re-registering on every render.
    const definitionRef = useRef(definition);
    definitionRef.current = definition;

    const enabled = options?.enabled ?? true;

    useEffect(
      () => {
        if (!enabled) {
          // No registration this effect run means nothing to leak and nothing for the cleanup
          // below to remove — the disabled state simply skips `registerTool` entirely.
          return;
        }
        const registration = registerTool(definitionRef.current);
        return () => {
          registration.remove();
        };
        // `deps` is caller-controlled (mirrors `useEffect`'s own contract); `enabled` is appended
        // explicitly so toggling it re-runs the effect even when `deps` is omitted or unchanged.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      deps ? [...deps, enabled] : undefined,
    );
  };
}
