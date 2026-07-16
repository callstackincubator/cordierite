import type {
  CordieriteClientState,
  CordieriteConnectInput,
  CordieriteListenerKind,
  CordieriteToolRegistration,
  CordieriteUnifiedListenerMap,
} from "./Cordierite.types";
import { cordieriteNativeModule } from "./CordieriteModule";
import { parseBootstrapPayload, parseBootstrapUrl } from "./bootstrap";
import { createCordieriteClient } from "./client";
import { realAppState } from "./client/real-app-state";
import {
  installCordieriteDeepLinkBootstrap as installDeepLinkBootstrap,
  type InstallCordieriteDeepLinkBootstrapOptions,
} from "./deep-link-install";
import { createUseCordieriteTool } from "./useCordieriteTool";

export * from "./Cordierite.types";
export { parseBootstrapPayload, parseBootstrapUrl };
export {
  createCordieriteClient,
  type CordieriteClient,
  type CordieriteNativeModuleLike,
  type CreateCordieriteClientOptions,
} from "./client";
export { cordieriteNativeModule };
export type { InstallCordieriteDeepLinkBootstrapOptions } from "./deep-link-install";
export type { CordierePublicApi, CordieriteSubscription } from "./public-api";

let cordieriteClientInstance: ReturnType<typeof createCordieriteClient> | null =
  null;

/**
 * Constructing a `CordieriteClient` (task 11) subscribes native event listeners immediately —
 * harmless when the native module is unavailable (`CordieriteModule.ts`'s `addListener` never
 * throws) but still real work. Deferring the construction itself until first use keeps this root
 * entry genuinely side-effect-free at import time (ARCHITECTURE.md §11 / task 12), not merely
 * non-throwing.
 */
const getCordieriteClientInstance = (): ReturnType<
  typeof createCordieriteClient
> => {
  if (!cordieriteClientInstance) {
    cordieriteClientInstance = createCordieriteClient(cordieriteNativeModule, {
      appState: realAppState,
    });
  }
  return cordieriteClientInstance;
};

/**
 * Default Cordierite client (native TurboModule, real `AppState`). Prefer importing the package
 * top-level functions (`registerTool`, `postEvent`, `addCordieriteListener`, `getCordieriteState`,
 * `installCordieriteDeepLinkBootstrap`) for typical app code; use this instance only for advanced
 * flows (manual `connect`/`send`, custom listeners, testing).
 *
 * A `Proxy` so that merely referencing this export (or importing the module) never constructs the
 * underlying client — only an actual property access (e.g. `cordieriteClient.getState()`) does,
 * which is also the first point any of this module's other top-level functions touch it.
 */
export const cordieriteClient = new Proxy(
  {} as ReturnType<typeof createCordieriteClient>,
  {
    get(_target, property, receiver) {
      return Reflect.get(getCordieriteClientInstance(), property, receiver);
    },
    has(_target, property) {
      return Reflect.has(getCordieriteClientInstance(), property);
    },
  }
);

/**
 * Subscribes the default client to deep links (initial URL + runtime `url` events). Safe to call
 * once; a later call with different `options` logs a dev warning instead of silently keeping the
 * first installation's options (see `deep-link-install.ts`).
 */
export function installCordieriteDeepLinkBootstrap(
  options?: InstallCordieriteDeepLinkBootstrapOptions
): void {
  installDeepLinkBootstrap(cordieriteClient, options);
}

/**
 * Register a Cordierite tool on the default client. Same as `cordieriteClient.registerTool` —
 * prefer this for typical app code so you do not need to touch the singleton. The returned
 * disposer removes only this registration (identity-based), even if a later call re-registers the
 * same tool name.
 */
export function registerTool<
  TInputSchema extends
    | import("@cordierite/shared").StandardSchemaV1
    | undefined,
  TOutputSchema extends
    | import("@cordierite/shared").StandardSchemaV1
    | undefined
>(registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>) {
  return cordieriteClient.registerTool(registration);
}

/** Emits an `event` frame on the default client while active; drops (dev warning) otherwise. */
export function postEvent(name: string, payload?: unknown): Promise<void> {
  return cordieriteClient.postEvent(name, payload);
}

/**
 * Unified listener API (ARCHITECTURE.md §11) on the default client: `stateChange`,
 * `sessionChange`, `error` (bootstrap parse/connect, socket, and tool-handler failures — one
 * channel). Every registration returns `{ remove() }`.
 */
export function addCordieriteListener<Kind extends CordieriteListenerKind>(
  kind: Kind,
  callback: CordieriteUnifiedListenerMap[Kind]
) {
  return cordieriteClient.addCordieriteListener(kind, callback);
}

/** Unified client state on the default client: `idle | connecting | active | reconnecting | closed`. */
export function getCordieriteState(): CordieriteClientState {
  return cordieriteClient.getClientState();
}

/**
 * Manually starts the claim/resume handshake on the default client from a decoded bootstrap payload
 * or explicit connect options. Most apps never call this directly — `installCordieriteDeepLinkBootstrap`
 * (or the `./auto` entry) drives it from incoming deep links — but it is exposed for manual bootstrap
 * flows (custom deep-link handling, QR scanning, tests).
 */
export function connect(input: CordieriteConnectInput): Promise<void> {
  return cordieriteClient.connect(input);
}

/**
 * `useEffect` wrapper around `registerTool`: registers on mount and whenever `deps` changes,
 * disposing the previous registration first (identity-safe — see `registerTool`'s doc comment).
 */
export const useCordieriteTool = createUseCordieriteTool(registerTool);
