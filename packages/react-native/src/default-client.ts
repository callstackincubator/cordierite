import {
  cordieriteNativeModule,
  cordieriteNativeResumeLeaseStore,
  isCordieriteNativeModuleAvailable,
} from "./CordieriteModule";
import { createCordieriteClient } from "./client";
import { realAppState } from "./client/real-app-state";
import { logger } from "./logger";

/**
 * The default client singleton and the native-availability gate the root (`.`) and `./auto`
 * entries both build on. Kept out of `index.ts` so `./auto` can reach the gate without `index.ts`
 * having to export it — `auto.ts` re-exports the whole root entry (`export * from "./index"`), so
 * anything exported there is public API by construction.
 */

let cordieriteClientInstance: ReturnType<typeof createCordieriteClient> | null =
  null;

/**
 * Whether Cordierite's native module exists in a build at all is decided entirely by
 * autolinking (see `docs/tasks/00-overview.md`'s "Inclusion" contract), not by any runtime
 * check here. When it is absent — Expo Go, a JS-only bundle, or the app excluded Cordierite
 * from autolinking — `TurboModuleRegistry` never finds it, and every exported function of the root
 * entry degrades to the exact `./noop` entry's behavior instead of the real client's — see
 * `noopIfNativeUnavailable`. Logged exactly once per process, not once per call, so an app that
 * calls these functions in a loop or on every render is not spammed.
 */
let warnedNativeModuleInert = false;
const warnNativeModuleInertOnce = (): void => {
  if (warnedNativeModuleInert) {
    return;
  }
  warnedNativeModuleInert = true;
  logger.warn(
    "Cordierite: the native module is not available in this build (Expo Go/JS-only, or " +
      "excluded via autolinking). The public API is inert, matching the `./noop` entry.",
  );
};

/** Runs `whenInert()` (a `./noop` call) instead of `whenAvailable()` (the real client call) once
 * the native module has been found unavailable, warning exactly once the first time this happens. */
export function noopIfNativeUnavailable<T>(
  whenAvailable: () => T,
  whenInert: () => T,
): T {
  if (!isCordieriteNativeModuleAvailable()) {
    warnNativeModuleInertOnce();
    return whenInert();
  }
  return whenAvailable();
}

/**
 * Constructing a `CordieriteClient` subscribes native event listeners immediately —
 * harmless when the native module is unavailable (`CordieriteModule.ts`'s `addListener` never
 * throws) but still real work. Deferring the construction itself until first use keeps the root
 * entry genuinely side-effect-free at import time (ARCHITECTURE.md §11), not merely
 * non-throwing.
 */
const getCordieriteClientInstance = (): ReturnType<
  typeof createCordieriteClient
> => {
  if (!cordieriteClientInstance) {
    cordieriteClientInstance = createCordieriteClient(cordieriteNativeModule, {
      appState: realAppState,
      resumeLeaseStore: cordieriteNativeResumeLeaseStore,
    });
  }
  return cordieriteClientInstance;
};

/**
 * Default Cordierite client (native TurboModule, real `AppState`). Prefer importing the package
 * top-level functions (`registerTool`, `postEvent`, `addCordieriteListener`, `getCordieriteState`,
 * `restoreSession`) for typical app code; use this instance only for advanced flows (manual
 * `connect`/`send`, custom listeners, testing).
 *
 * A `Proxy` so that merely referencing this export (or importing the module) never constructs the
 * underlying client — only an actual property access (e.g. `cordieriteClient.getState()`) does,
 * which is also the first point the root entry's top-level functions touch it.
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
  },
);
