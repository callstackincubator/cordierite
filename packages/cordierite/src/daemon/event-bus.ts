/**
 * Typed in-process event bus (ARCHITECTURE.md §5 event kinds). The RPC layer (for
 * `events.subscribe`/`events.since`) and audit subscribe here; this module owns fan-out plus a
 * per-session retention ring buffer, and must never let a throwing subscriber take down the daemon
 * or another subscriber.
 *
 * Retention (issue #6): every session-scoped event (`sessionId` set), except the high-frequency
 * kinds in `EXCLUDED_FROM_RETENTION`, is appended to a per-session ring buffer with a
 * monotonically increasing `seq`, capped at `bufferSize` entries (oldest dropped first). A
 * session's buffer is discarded the moment it emits a terminal event (`session_expired` /
 * `session_revoked`) — "terminal states free the alias" (sessions.ts) applies to retained events
 * too, matching "no persisted history" (ARCHITECTURE.md §3/§13) — or via an explicit `drop()` for
 * the pending-link discard paths that never reach one of those event kinds. Daemon-wide events (no
 * `sessionId`, e.g. `daemon_started`) are fanned out but never buffered.
 */

import type { EventKind, EventNotification } from "@cordierite/shared";

import type { Clock } from "../cli/types.js";

export type EventBusEmitInput = Omit<EventNotification, "ts" | "seq"> & { kind: EventKind; ts?: number };

export type EventBusListener = (event: EventNotification) => void;

/** Terminal event kinds whose arrival for a session discards that session's retained buffer. */
const TERMINAL_EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["session_expired", "session_revoked"]);

/** Fanned out live like any other event, but never appended to the retention buffer: a single
 * chatty `tools.call` can emit far more of these than `bufferSize` allows, which would otherwise
 * evict every retained `app_event` for the session — defeating the reason the buffer exists.
 * `tool_call_started`/`tool_call_finished` (one pair per call, not per progress tick) are still
 * retained. */
const EXCLUDED_FROM_RETENTION: ReadonlySet<EventKind> = new Set<EventKind>(["tool_call_progress"]);

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
  /** Discards `sessionId`'s retained buffer outright, with no event required. Covers the pending-
   * link discard paths that never reach a terminal event kind (attempt-limit exceeded, the TTL
   * free-timer) — `TERMINAL_EVENT_KINDS` only catches the ones that *do* emit one. Idempotent. */
  drop: (sessionId: string) => void;
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
        } else if (!EXCLUDED_FROM_RETENTION.has(notification.kind)) {
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
      const sessionCursor = cursors.get(sessionId) ?? 0;

      // Never hand back the live buffer array itself — `emit()` keeps pushing into it after this
      // call returns, and a caller that gets `events` by reference (the common case: no filter
      // narrows it below) would see it mutate underneath it.
      let events = buffer.slice();

      if (query.since !== undefined) {
        events = events.filter((event) => event.seq > query.since!);
      }

      if (query.kinds !== undefined) {
        const kinds = new Set(query.kinds);
        events = events.filter((event) => kinds.has(event.kind));
      }

      if (query.limit !== undefined && events.length > query.limit) {
        // Keep the OLDEST N, not the newest: `limit` exists to bound one response, not to skip
        // ahead — a caller pages forward by re-calling with `since` set to the response's own
        // `cursor`. Keeping the newest N instead would make that same re-call return the same
        // window forever, silently and unrecoverably losing whatever `limit` cut off.
        events = events.slice(0, query.limit);
      }

      // The cursor a caller should resume from: the last event actually returned, so paging
      // through a `limit`-truncated response with `since: cursor` always advances. Only when
      // nothing was returned (empty buffer, or every retained event was filtered out) does it fall
      // back to the session's true high-water mark, so an empty page still lets a caller skip past
      // events it explicitly filtered out (by `kinds`) rather than re-fetching them forever.
      const cursor = events.length > 0 ? events[events.length - 1]!.seq : sessionCursor;

      return { events, cursor };
    },
    drop: (sessionId) => {
      buffers.delete(sessionId);
      cursors.delete(sessionId);
    },
  };
};
