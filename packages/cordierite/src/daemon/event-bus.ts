/**
 * Typed in-process event bus (ARCHITECTURE.md §5 event kinds). The RPC layer (for
 * `events.subscribe`/`events.since`) and audit subscribe here; this module owns fan-out plus a
 * per-session retention ring buffer, and must never let a throwing subscriber take down the daemon
 * or another subscriber.
 *
 * Retention (issue #6): every session-scoped event (`sessionId` set) is appended to a per-session
 * ring buffer with a monotonically increasing `seq`, capped at `bufferSize` entries (oldest
 * dropped first). A session's buffer is discarded the moment it emits a terminal event
 * (`session_expired` / `session_revoked`) — "terminal states free the alias" (sessions.ts) applies
 * to retained events too, matching "no persisted history" (ARCHITECTURE.md §3/§13). Daemon-wide
 * events (no `sessionId`, e.g. `daemon_started`) are fanned out but never buffered.
 */

import type { EventKind, EventNotification } from "@cordierite/shared";

import type { Clock } from "../cli/types.js";

export type EventBusEmitInput = Omit<EventNotification, "ts" | "seq"> & { kind: EventKind; ts?: number };

export type EventBusListener = (event: EventNotification) => void;

/** Terminal event kinds whose arrival for a session discards that session's retained buffer. */
const TERMINAL_EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["session_expired", "session_revoked"]);

export type EventsSinceQuery = {
  since?: number;
  kinds?: EventKind[];
  limit?: number;
};

export type EventsSinceQueryResult = {
  events: EventNotification[];
  cursor: number;
};

export type EventBus = {
  emit: (event: EventBusEmitInput) => void;
  subscribe: (listener: EventBusListener) => () => void;
  /** Drains the retained buffer for `sessionId`. Returns an empty result (`cursor: 0`) for a
   * session with no retained events (nothing emitted yet, or its buffer already discarded). */
  since: (sessionId: string, query?: EventsSinceQuery) => EventsSinceQueryResult;
};

export type CreateEventBusOptions = {
  clock?: Clock;
  /** Max retained events per session (ARCHITECTURE.md §5's `eventBufferSize`); default 256. */
  bufferSize?: number;
};

export const createEventBus = (options: CreateEventBusOptions = {}): EventBus => {
  const clock = options.clock ?? { now: () => new Date() };
  const bufferSize = options.bufferSize ?? 256;

  const listeners = new Set<EventBusListener>();
  const buffers = new Map<string, EventNotification[]>();
  const cursors = new Map<string, number>();

  const appendToBuffer = (sessionId: string, notification: EventNotification): void => {
    const buffer = buffers.get(sessionId) ?? [];
    buffer.push(notification);

    if (buffer.length > bufferSize) {
      buffer.splice(0, buffer.length - bufferSize);
    }

    buffers.set(sessionId, buffer);
  };

  return {
    emit: (event) => {
      const sessionId = event.sessionId;
      const seq = sessionId !== undefined ? (cursors.get(sessionId) ?? 0) + 1 : 0;

      if (sessionId !== undefined) {
        cursors.set(sessionId, seq);
      }

      const notification: EventNotification = {
        ...event,
        ts: event.ts ?? clock.now().getTime(),
        seq,
      };

      if (sessionId !== undefined) {
        if (TERMINAL_EVENT_KINDS.has(notification.kind)) {
          // The terminal event itself is still delivered live (fan-out below) and reported through
          // `since`'s `cursor`, but is not retained — nothing can legitimately ask for it again once
          // the session is gone.
          buffers.delete(sessionId);
          cursors.delete(sessionId);
        } else {
          appendToBuffer(sessionId, notification);
        }
      }

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
    since: (sessionId, query = {}) => {
      const buffer = buffers.get(sessionId) ?? [];
      const cursor = cursors.get(sessionId) ?? 0;

      let events = buffer;

      if (query.since !== undefined) {
        events = events.filter((event) => event.seq > query.since!);
      }

      if (query.kinds !== undefined) {
        const kinds = new Set(query.kinds);
        events = events.filter((event) => kinds.has(event.kind));
      }

      if (query.limit !== undefined && events.length > query.limit) {
        events = events.slice(events.length - query.limit);
      }

      return { events, cursor };
    },
  };
};
