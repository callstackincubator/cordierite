import type { ToolDescriptor } from "@cordierite/shared";
import type { DependencyList } from "react";

import type {
  CordieriteClientState,
  CordieriteConnectInput,
  CordieriteListenerKind,
  CordieriteRuntimeSchema,
  CordieriteToolRegistration,
  CordieriteUnifiedListenerMap,
} from "./Cordierite.types";
import type { InstallCordieriteDeepLinkBootstrapOptions } from "./deep-link-install";

export type CordieriteSubscription = { remove(): void };

/**
 * Public API surface shared by the `.` (real) and `./noop` (inert) entries (ARCHITECTURE.md §11).
 * Both entries are typed against this single interface so they cannot drift — see
 * `__tests__/noop-parity.test.ts`, which mirrors the pattern of `connect-options-parity.test.ts`.
 */
export type CordierePublicApi = {
  registerTool<
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined
  >(
    registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>
  ): CordieriteSubscription;

  useCordieriteTool<
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined
  >(
    definition: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
    deps?: DependencyList
  ): void;

  postEvent(name: string, payload?: unknown): Promise<void>;

  getRegisteredTools(): ToolDescriptor[];

  installCordieriteDeepLinkBootstrap(
    options?: InstallCordieriteDeepLinkBootstrapOptions
  ): void;

  addCordieriteListener<Kind extends CordieriteListenerKind>(
    kind: Kind,
    callback: CordieriteUnifiedListenerMap[Kind]
  ): CordieriteSubscription;

  getCordieriteState(): CordieriteClientState;

  connect(input: CordieriteConnectInput): Promise<void>;
};
