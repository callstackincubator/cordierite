/**
 * `@cordierite/react-native/noop` — inert entry (ARCHITECTURE.md §11): identical public API to the
 * root (`.`) entry, but every operation is a no-op. Intended for release-build compile-out via Metro
 * `resolveRequest` or a conditional `require` (see the package README's "Compiling Cordierite out
 * of production" section) — swap `@cordierite/react-native` (and `/auto`) for this entry so no
 * Cordierite code, native or JS, ships in that build.
 *
 * Typed against the same `CordierePublicApi` interface as `./index.ts` (see
 * `__tests__/noop-parity.test.ts`) so the two cannot drift.
 */
import type { ToolDescriptor } from "@cordierite/shared";

import type {
  CordieriteClientState,
  CordieriteConnectInput,
  CordieriteListenerKind,
  CordieriteToolRegistration,
  CordieriteUnifiedListenerMap,
} from "./Cordierite.types";
import { CordieriteDisabledError } from "./Cordierite.types";
import type { InstallCordieriteDeepLinkBootstrapOptions } from "./deep-link-install";
import type { CordieriteSubscription } from "./public-api";
import { createUseCordieriteTool } from "./useCordieriteTool";

export * from "./Cordierite.types";
export type { InstallCordieriteDeepLinkBootstrapOptions } from "./deep-link-install";
export type { CordierePublicApi, CordieriteSubscription } from "./public-api";
export type { UseCordieriteToolOptions } from "./useCordieriteTool";

const noopSubscription: CordieriteSubscription = { remove() {} };

/** Accepts any registration and returns a disposer; the tool is never actually registered anywhere. */
export function registerTool<
  TInputSchema extends
    import("@cordierite/shared").StandardSchemaV1 | undefined,
  TOutputSchema extends
    import("@cordierite/shared").StandardSchemaV1 | undefined,
>(
  _registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>,
): CordieriteSubscription {
  return noopSubscription;
}

/** `useEffect` wrapper around the inert `registerTool` above — same mount/deps/`options.enabled`
 * behavior as the real entry, no-op body. */
export const useCordieriteTool = createUseCordieriteTool(registerTool);

/** No-op: never sends anything. */
export async function postEvent(
  _name: string,
  _payload?: unknown,
): Promise<void> {}

/** Always empty: this build never registers any tool anywhere. */
export function getRegisteredTools(): ToolDescriptor[] {
  return [];
}

/** No-op: this build never installs deep-link listeners. */
export function installCordieriteDeepLinkBootstrap(
  _options?: InstallCordieriteDeepLinkBootstrapOptions,
): void {}

/** No-op: the returned subscription is inert and the callback never fires. */
export function addCordieriteListener<Kind extends CordieriteListenerKind>(
  _kind: Kind,
  _callback: CordieriteUnifiedListenerMap[Kind],
): CordieriteSubscription {
  return noopSubscription;
}

/** Always `"idle"`. */
export function getCordieriteState(): CordieriteClientState {
  return "idle";
}

/** Always rejects with a `CordieriteDisabledError` (`code: "cordierite_disabled"`). */
export function connect(_input: CordieriteConnectInput): Promise<void> {
  return Promise.reject(new CordieriteDisabledError());
}
