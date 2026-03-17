/**
 * Web / unsupported-platform stub for Metro resolution.
 *
 * `connect`, `send`, `close`, and `getState` throw — Cordierite is iOS/Android-only.
 *
 * `addListener` returns a no-op subscription on purpose: the package eagerly constructs
 * `cordieriteClient` at import time, which registers internal listeners. Throwing here would crash
 * any web bundle that merely imports the package. Apps must still not call Cordierite APIs on web.
 */
import type { CordieriteConnectionState } from "./Cordierite.types";
import type { CordieriteNativeModuleLike } from "./client-types";
import { logger } from "./logger";

const unsupported = (what: string): never => {
  logger.warn(`Cordierite native module is not available on web (${what})`);
  throw new Error(
    "react-native-cordierite is only available on iOS and Android development or production builds."
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
    return unsupported("getState");
  },
  addListener() {
    return {
      remove() {},
    };
  },
};
