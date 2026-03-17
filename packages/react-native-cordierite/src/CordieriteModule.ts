import type {
  CordieriteCloseEvent,
  CordieriteConnectionState,
  CordieriteMessageEvent,
  CordieriteModuleEvents,
  CordieriteStateChangeEvent,
} from "./Cordierite.types";
import { NativeCordierite } from "./NativeCordierite";
import type { CordieriteNativeModuleLike } from "./client-types";
import { logger } from "./logger";

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
    const subscription = NativeCordierite.onStateChange((nativeEvent) => {
      listener({
        state: nativeEvent.state as CordieriteStateChangeEvent["state"],
      });
    });
    return { remove: () => subscription.remove() };
  },

  message(listener) {
    const subscription = NativeCordierite.onMessage((nativeEvent) => {
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
    const subscription = NativeCordierite.onError((nativeEvent) => {
      listener({
        code: nativeEvent.code,
        message: nativeEvent.message,
      });
    });
    return { remove: () => subscription.remove() };
  },

  close(listener) {
    const subscription = NativeCordierite.onClose((nativeEvent) => {
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

export const cordieriteNativeModule: CordieriteNativeModuleLike = {
  connect: (options) => NativeCordierite.connect(options),
  send: (message) => NativeCordierite.send(message),
  close: () => NativeCordierite.close(),
  getState: (): CordieriteConnectionState =>
    NativeCordierite.getState() as CordieriteConnectionState,
  addListener(eventName, listener) {
    const attach = bridgeListeners[eventName];
    if (!attach) {
      throw new Error(`Unknown Cordierite event: ${String(eventName)}`);
    }
    return attach(listener as CordieriteModuleEvents[typeof eventName]);
  },
};
