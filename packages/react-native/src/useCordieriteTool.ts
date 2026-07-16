import { useEffect, useRef, type DependencyList } from "react";

import type {
  CordieriteRuntimeSchema,
  CordieriteToolRegistration,
} from "./Cordierite.types";
import type { CordieriteSubscription } from "./public-api";

type ToolRegistrar = <
  TInputSchema extends CordieriteRuntimeSchema | undefined,
  TOutputSchema extends CordieriteRuntimeSchema | undefined
>(
  registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>
) => CordieriteSubscription;

/**
 * Builds `useCordieriteTool` on top of a `registerTool` implementation. Both the real (`.`) and
 * inert (`./noop`) entries call this with their own `registerTool`, so the hook's remount/dependency
 * behavior can never drift between the two (ARCHITECTURE.md §11).
 */
export function createUseCordieriteTool(registerTool: ToolRegistrar) {
  /**
   * `useEffect` wrapper around `registerTool`: registers on mount and whenever `deps` changes,
   * disposing the previous registration first. Relies on the registry's identity-safe disposer
   * (task 11) so remount / fast-refresh churn never leaks a stale registration or clobbers a newer
   * one under the same tool name.
   */
  return function useCordieriteTool<
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined
  >(
    definition: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
    deps?: DependencyList
  ): void {
    // Keeps the latest definition available to the effect without making it part of the effect's
    // own dependency list — callers control re-registration explicitly via `deps`, matching
    // `registerTool`'s own explicit-identity contract rather than re-registering on every render.
    const definitionRef = useRef(definition);
    definitionRef.current = definition;

    useEffect(() => {
      const registration = registerTool(definitionRef.current);
      return () => {
        registration.remove();
      };
    }, deps);
  };
}
