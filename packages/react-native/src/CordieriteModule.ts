import type {
  CordieriteCloseEvent,
  CordieriteConnectionState,
  CordieriteMessageEvent,
  CordieriteModuleEvents,
  CordieriteStateChangeEvent,
} from "./Cordierite.types";
import type { ResumeLeaseStore } from "./client/resume-lease";
import type { CordieriteNativeModuleLike } from "./client-types";
import { logger } from "./logger";

// Metro/Node's CommonJS `require` is available at runtime in every environment this file actually
// ships to (RN bundles, and `bun test` via its own CJS interop); this narrow local declaration
// avoids pulling in `@types/node` just for the lazy-resolution trick below.
declare const require: (id: string) => Record<string, unknown>;

type NativeCordieriteModule = typeof import("./NativeCordierite");

/**
 * ARCHITECTURE.md §11 / task 12: the root entry is side-effect-free, so the TurboModule lookup
 * (`TurboModuleRegistry.getEnforcing`, which throws when the native module was never registered —
 * Expo Go, a misconfigured build, or a JS-only environment) must happen lazily on the *first* native
 * call, never at import time. `require` here (not a static `import`) is what makes the lookup lazy:
 * `./NativeCordierite`'s top-level `getEnforcing` call only runs the first time this function
 * actually executes.
 */
let cachedNative: NativeCordieriteModule["NativeCordierite"] | null = null;

const resolveNativeModule = (): NativeCordieriteModule["NativeCordierite"] => {
  if (cachedNative) {
    return cachedNative;
  }

  try {
    const nativeModule =
      require("./NativeCordierite") as NativeCordieriteModule;
    const resolvedNative = nativeModule.NativeCordierite;
    if (!resolvedNative) {
      // Defensive: the real `NativeCordierite.ts` either resolves or throws (it never resolves to
      // a nullish value), but a test double or an unexpected bundler transform could — treat that
      // the same as "not found" rather than deferring a crash to the first actual method call.
      throw new Error("NativeCordierite module resolved to a nullish value.");
    }
    cachedNative = resolvedNative;
    return cachedNative;
  } catch (error) {
    throw new Error(
      '@cordierite/react-native could not find its native module ("Cordierite"). ' +
        "This library ships native code and requires a custom development build — Expo Go and " +
        "JS-only bundles do not include it. Rebuild with `expo run:ios`/`expo run:android` (or " +
        `your bare React Native dev client), then try again. (${
          error instanceof Error ? error.message : String(error)
        })`
    );
  }
};

const toErrorPhase = (
  phase: string | undefined
):
  | "bootstrap"
  | "tls"
  | "connect"
  | "handshake"
  | "session"
  | "transport"
  | "config"
  | undefined => {
  switch (phase) {
    case "bootstrap":
    case "tls":
    case "connect":
    case "handshake":
    case "session":
    case "transport":
    case "config":
      return phase;
    default:
      return undefined;
  }
};

const parseMessagePayload = (rawMessage: string): Record<string, unknown> => {
  const parsed = JSON.parse(rawMessage) as unknown;
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
};

type EventSubscription = { remove(): void };

const bridgeListeners: {
  [K in keyof CordieriteModuleEvents]: (
    listener: CordieriteModuleEvents[K]
  ) => EventSubscription;
} = {
  stateChange(listener) {
    const subscription = resolveNativeModule().onStateChange((nativeEvent) => {
      listener({
        state: nativeEvent.state as CordieriteStateChangeEvent["state"],
      });
    });
    return { remove: () => subscription.remove() };
  },

  message(listener) {
    const subscription = resolveNativeModule().onMessage((nativeEvent) => {
      const rawMessage = nativeEvent.rawMessage;
      let message: CordieriteMessageEvent["message"];
      try {
        message = parseMessagePayload(rawMessage);
      } catch {
        logger.warn(
          "incoming message is not valid JSON; exposing empty object to listeners"
        );
        message = {};
      }
      listener({ message, rawMessage });
    });
    return { remove: () => subscription.remove() };
  },

  error(listener) {
    const subscription = resolveNativeModule().onError((nativeEvent) => {
      listener({
        code: nativeEvent.code,
        message: nativeEvent.message,
        phase: toErrorPhase(nativeEvent.phase ?? undefined),
        nativeCode: nativeEvent.nativeCode ?? undefined,
        closeReason: nativeEvent.closeReason ?? undefined,
        isRetryable: nativeEvent.isRetryable ?? undefined,
        hint: nativeEvent.hint ?? undefined,
      });
    });
    return { remove: () => subscription.remove() };
  },

  close(listener) {
    const subscription = resolveNativeModule().onClose((nativeEvent) => {
      const event: CordieriteCloseEvent = {};
      if (nativeEvent.code != null) {
        event.code = nativeEvent.code;
      }
      if (nativeEvent.reason != null) {
        event.reason = nativeEvent.reason;
      }
      listener(event);
    });
    return { remove: () => subscription.remove() };
  },
};

const noopSubscription: EventSubscription = { remove() {} };

export const cordieriteNativeModule: CordieriteNativeModuleLike = {
  connect: (options) => resolveNativeModule().connect(options),
  send: (message) => resolveNativeModule().send(message),
  close: () => resolveNativeModule().close(),
  /**
   * Never throws, even when the native module cannot be resolved: mirrors `CordieriteModule.web.ts`
   * (see its doc comment) since this is called unconditionally from code paths that must survive a
   * missing native module (e.g. the deep-link handler's "already connecting/active?" guard) before
   * an app-level `connect()` call ever gets a chance to surface the actionable error.
   */
  getState: (): CordieriteConnectionState => {
    try {
      return resolveNativeModule().getState() as CordieriteConnectionState;
    } catch (error) {
      logger.debug(
        "getState(): native module unavailable, reporting idle",
        error
      );
      return "idle";
    }
  },
  /**
   * Never throws: constructing a `CordieriteClient` (task 11) subscribes three of these at creation
   * time, and that must stay side-effect-free at import time (task 12). When the native module is
   * unavailable the returned subscription is an inert no-op — the listener simply never fires until
   * an app-level native call (e.g. `connect()`) has a chance to surface the real, actionable error.
   */
  addListener(eventName, listener) {
    const attach = bridgeListeners[eventName];
    if (!attach) {
      throw new Error(`Unknown Cordierite event: ${String(eventName)}`);
    }
    try {
      return attach(listener as CordieriteModuleEvents[typeof eventName]);
    } catch (error) {
      logger.debug(
        `addListener("${String(
          eventName
        )}"): native module unavailable, subscription is inert`,
        error
      );
      return noopSubscription;
    }
  },
};

/** @internal Production adapter for the native process-memory resume lease. */
export const cordieriteNativeResumeLeaseStore: ResumeLeaseStore = {
  get() {
    try {
      return resolveNativeModule().getResumeLease();
    } catch (error) {
      logger.debug(
        "getResumeLease(): native module unavailable, reporting no lease",
        error
      );
      return null;
    }
  },
  clear() {
    try {
      resolveNativeModule().clearResumeLease();
    } catch (error) {
      logger.debug(
        "clearResumeLease(): native module unavailable, clear is inert",
        error
      );
    }
  },
};
