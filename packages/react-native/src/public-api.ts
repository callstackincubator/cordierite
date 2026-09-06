import type { ToolDescriptor } from "@cordierite/shared";
import type { DependencyList } from "react";

import type {
  CordieriteBuildConfig,
  CordieriteClientState,
  CordieriteConnectInput,
  CordieriteJsonSchemaObject,
  CordieriteListenerKind,
  CordieriteRuntimeSchema,
  CordieriteToolRegistration,
  CordieriteUnifiedListenerMap,
} from "./Cordierite.types";
import type { UseCordieriteToolOptions } from "./useCordieriteTool";

export type CordieriteSubscription = { remove(): void };

/**
 * Public API surface shared by the `.` (real) and `./noop` (inert) entries (ARCHITECTURE.md §11).
 * Both entries are typed against this single interface so they cannot drift — see
 * `__tests__/noop-parity.test.ts`, which mirrors the pattern of `connect-options-parity.test.ts`.
 */
export type CordierePublicApi = {
  registerTool<
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined,
  >(
    registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
  ): CordieriteSubscription;

  useCordieriteTool<
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined,
  >(
    definition: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
    deps?: DependencyList,
    options?: UseCordieriteToolOptions,
  ): void;

  /** Type-only helper for raw JSON Schema tool schemas; identity at runtime. */
  jsonSchema<T = Record<string, unknown>>(
    schema: Record<string, unknown>,
  ): CordieriteJsonSchemaObject<T>;

  postEvent(name: string, payload?: unknown): Promise<void>;

  getRegisteredTools(): ToolDescriptor[];

  addCordieriteListener<Kind extends CordieriteListenerKind>(
    kind: Kind,
    callback: CordieriteUnifiedListenerMap[Kind],
  ): CordieriteSubscription;

  restoreSession(): Promise<boolean>;

  getCordieriteState(): CordieriteClientState;

  connect(input: CordieriteConnectInput): Promise<void>;

  getCordieriteBuildConfig(): CordieriteBuildConfig;
};
