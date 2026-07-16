import type {
  CordieriteListenerKind,
  CordieriteUnifiedListenerMap,
} from "../Cordierite.types";
import { logger } from "../logger";

export type UnifiedListenerBus = {
  addListener<Kind extends CordieriteListenerKind>(
    kind: Kind,
    callback: CordieriteUnifiedListenerMap[Kind]
  ): { remove(): void };
  emit<Kind extends CordieriteListenerKind>(
    kind: Kind,
    event: Parameters<CordieriteUnifiedListenerMap[Kind]>[0]
  ): void;
};

/**
 * The single event bus behind `addCordieriteListener` (ARCHITECTURE.md §11): `stateChange`,
 * `sessionChange`, and `error` (bootstrap/connect/socket/tool-handler failures, one channel).
 */
export const createUnifiedListenerBus = (): UnifiedListenerBus => {
  const listeners: {
    [K in CordieriteListenerKind]: Set<CordieriteUnifiedListenerMap[K]>;
  } = {
    stateChange: new Set(),
    sessionChange: new Set(),
    error: new Set(),
  };

  return {
    addListener(kind, callback) {
      const set = listeners[kind] as Set<typeof callback>;
      set.add(callback);
      return {
        remove: () => {
          set.delete(callback);
        },
      };
    },

    emit(kind, event) {
      const set = listeners[kind] as Set<(event: unknown) => void>;
      for (const callback of set) {
        try {
          callback(event);
        } catch (error) {
          logger.warn(`Cordierite "${kind}" listener threw`, error);
        }
      }
    },
  };
};
