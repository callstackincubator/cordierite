/**
 * Typed in-process event bus (ARCHITECTURE.md §5 event kinds). The RPC layer (task 05, for
 * `events.subscribe`) and audit (task 13) subscribe here; this module only owns fan-out and must
 * never let a throwing subscriber take down the daemon or another subscriber.
 */

import type { EventKind, EventNotification } from "@cordierite/shared";

import type { Clock } from "../cli/types.js";

export type EventBusEmitInput = Omit<EventNotification, "ts"> & { kind: EventKind; ts?: number };

export type EventBusListener = (event: EventNotification) => void;

export type EventBus = {
  emit: (event: EventBusEmitInput) => void;
  subscribe: (listener: EventBusListener) => () => void;
};

export const createEventBus = (clock: Clock = { now: () => new Date() }): EventBus => {
  const listeners = new Set<EventBusListener>();

  return {
    emit: (event) => {
      const notification: EventNotification = {
        ...event,
        ts: event.ts ?? clock.now().getTime(),
      };

      for (const listener of listeners) {
        try {
          listener(notification);
        } catch {
          // A misbehaving subscriber must never crash the daemon or block other subscribers.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
};
