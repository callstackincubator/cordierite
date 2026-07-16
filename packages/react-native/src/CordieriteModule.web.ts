/**
 * Web / unsupported-platform stub for Metro resolution.
 *
 * `connect`, `send`, and `close` throw — Cordierite is iOS/Android-only. `getState` returns
 * `"idle"` rather than throwing: it is called unconditionally from code paths that run on every
 * platform (e.g. the deep-link handler's "already connecting/active?" guard), and throwing there
 * would crash any web bundle that merely imports the package before an app ever calls a Cordierite
 * API. Apps must still not call the throwing APIs on web.
 *
 * `addListener` returns a no-op subscription for the same reason: the package eagerly constructs
 * `cordieriteClient` at import time, which registers internal listeners.
 */
import type { CordieriteConnectionState } from "./Cordierite.types";
import type { ResumeLeaseStore } from "./client/resume-lease";
import type { CordieriteNativeModuleLike } from "./client-types";
import { logger } from "./logger";

const unsupported = (what: string): never => {
  logger.warn(`Cordierite native module is not available on web (${what})`);
  throw new Error(
    "@cordierite/react-native is only available on iOS and Android development or production builds."
  );
};

export const cordieriteNativeModule: CordieriteNativeModuleLike = {
  async connect() {
    unsupported("connect");
  },
  async send() {
    unsupported("send");
  },
  async close() {
    unsupported("close");
  },
  getState(): CordieriteConnectionState {
    return "idle";
  },
  addListener() {
    return {
      remove() {},
    };
  },
};

/** @internal Unsupported platforms never have a native process-memory lease. */
export const cordieriteNativeResumeLeaseStore: ResumeLeaseStore = {
  get: () => null,
  clear() {},
};
