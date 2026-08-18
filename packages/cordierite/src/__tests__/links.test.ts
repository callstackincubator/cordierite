/**
 * Unit tests for the pending-link registry's TTL/free-timer behavior (review finding: unclaimed
 * links used to live in the map forever). Uses a fake {@link TimerFns} so the TTL and the
 * subsequent free-window can be advanced deterministically by invoking the scheduled callbacks
 * directly, rather than sleeping on wall-clock time.
 */

import { describe, expect, test } from "vitest";

import type { EventNotification } from "@cordierite/shared";

import { createPendingLinkRegistry } from "../daemon/links.js";
import type { TimerFns, TimerHandle } from "../daemon/timers.js";

type ScheduledTimeout = {
  handle: TimerHandle;
  callback: () => void;
};

const createFakeTimers = (): { timers: TimerFns; scheduled: ScheduledTimeout[] } => {
  const scheduled: ScheduledTimeout[] = [];
  let nextHandle = 1;

  const timers: TimerFns = {
    setTimeout: (callback) => {
      const handle = nextHandle as unknown as TimerHandle;
      nextHandle += 1;
      scheduled.push({ handle, callback });
      return handle;
    },
    clearTimeout: (handle) => {
      const index = scheduled.findIndex((entry) => entry.handle === handle);

      if (index !== -1) {
        scheduled.splice(index, 1);
      }
    },
    setInterval: () => {
      throw new Error("not used by links.ts");
    },
    clearInterval: () => {},
  };

  return { timers, scheduled };
};

/** Fires the oldest still-scheduled timeout, mimicking real `setTimeout`'s one-shot semantics (the
 * entry is removed *before* the callback runs, so a callback that schedules a new timer — as the
 * TTL callback here does — doesn't get confused with itself). */
const fireNext = (scheduled: ScheduledTimeout[]): void => {
  const next = scheduled.shift();
  next?.callback();
};

describe("PendingLinkRegistry: TTL expiry and eventual free", () => {
  test("TTL fires link_expired (not session_expired) and keeps the record claimable-as-expired; a further grace window then frees it", () => {
    const { timers, scheduled } = createFakeTimers();
    const events: EventNotification[] = [];

    const registry = createPendingLinkRegistry({
      getEndpoint: () => ({ family: 4, address: "127.0.0.1", port: 8443 }),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      timers,
      eventBus: {
        emit: (event) => events.push({ ...event, ts: event.ts ?? 0, seq: 0 }),
        subscribe: () => () => {},
        since: () => ({ events: [], cursor: 0 }),
      },
    });

    const { link } = registry.create(30);
    expect(registry.get(link.sessionId)).toBeDefined();
    expect(scheduled).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual(["link_created"]);

    // Advance past the TTL: the registry must emit its own `link_expired` kind, never the
    // `session_expired` kind reserved for a claimed session's SUSPENDED -> EXPIRED transition.
    fireNext(scheduled);

    expect(events.map((event) => event.kind)).toEqual(["link_created", "link_expired"]);
    expect(events[1]!.sessionId).toBe(link.sessionId);

    // The record survives the TTL firing (a late claim within the grace window must still see
    // "expired", not "unknown") — a fresh free-timer is scheduled instead of the record vanishing.
    expect(registry.get(link.sessionId)).toBeDefined();
    expect(scheduled).toHaveLength(1);

    // Advance past the free-window: the record is now actually removed from the map, so a daemon
    // that mints many links and nobody claims them does not grow unbounded.
    fireNext(scheduled);

    expect(registry.get(link.sessionId)).toBeUndefined();
  });

  test("a claim before the free window fires clears the pending free-timer (disposeAll has nothing left to clean up)", () => {
    const { timers, scheduled } = createFakeTimers();

    const registry = createPendingLinkRegistry({
      getEndpoint: () => ({ family: 4, address: "127.0.0.1", port: 8443 }),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      timers,
      eventBus: { emit: () => {}, subscribe: () => () => {}, since: () => ({ events: [], cursor: 0 }) },
    });

    const { link } = registry.create(30);
    fireNext(scheduled); // TTL fires -> free-timer scheduled
    expect(scheduled).toHaveLength(1);

    registry.discard(link.sessionId);

    expect(registry.get(link.sessionId)).toBeUndefined();
    expect(scheduled).toHaveLength(0);
  });
});
