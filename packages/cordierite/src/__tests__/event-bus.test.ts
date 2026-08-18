/**
 * Pure unit tests for `daemon/event-bus.ts`'s retention buffer (issue #6): cursor assignment,
 * `since` filtering, the ring buffer's eviction cap, and the terminal-state buffer drop. No daemon,
 * no socket, no device — `createEventBus` takes a `Clock` seam precisely so this needs none of that.
 */

import { describe, expect, test } from "vitest";

import { createEventBus } from "../daemon/event-bus.js";

const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

describe("event-bus: retention buffer", () => {
  test("assigns a monotonically increasing per-session seq, starting at 1", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "a" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "b" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "c" } });

    const { events, cursor } = bus.since("s1");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(cursor).toBe(3);
  });

  test("seq counters are independent per session", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s2", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });

    expect(bus.since("s1").cursor).toBe(2);
    expect(bus.since("s2").cursor).toBe(1);
  });

  test("daemon-wide events (no sessionId) are fanned out but never buffered", () => {
    const bus = createEventBus({ clock });
    const seen: number[] = [];
    bus.subscribe((event) => seen.push(event.seq));

    bus.emit({ kind: "daemon_started", data: {} });

    expect(seen).toEqual([0]);
    // Nothing to drain for any session id — a daemon-wide event was never anyone's to retain.
    expect(bus.since("s1")).toEqual({ events: [], cursor: 0 });
  });

  test("since excludes everything at or before the given cursor", () => {
    const bus = createEventBus({ clock });

    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { i } });
    }

    const { events } = bus.since("s1", { since: 2 });
    expect(events.map((event) => event.seq)).toEqual([3, 4, 5]);
  });

  test("kinds filters the retained buffer without disturbing seq/cursor", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "tools_changed", sessionId: "s1", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });

    const { events, cursor } = bus.since("s1", { kinds: ["app_event"] });
    expect(events.map((event) => event.kind)).toEqual(["app_event", "app_event"]);
    expect(events.map((event) => event.seq)).toEqual([1, 3]);
    // cursor reflects the whole session, not just the filtered subset.
    expect(cursor).toBe(3);
  });

  test("limit truncates to the newest N, cursor still reflects everything retained", () => {
    const bus = createEventBus({ clock });

    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { i } });
    }

    const { events, cursor } = bus.since("s1", { limit: 2 });
    expect(events.map((event) => event.seq)).toEqual([4, 5]);
    expect(cursor).toBe(5);
  });

  test("the ring buffer caps retention at bufferSize, dropping the oldest first", () => {
    const bus = createEventBus({ clock, bufferSize: 3 });

    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { i } });
    }

    const { events, cursor } = bus.since("s1");
    // seq 1 and 2 were evicted; the cursor still reflects the true total emitted, not just retained.
    expect(events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(cursor).toBe(5);
  });

  test("a terminal event (session_expired/session_revoked) discards the session's buffer", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "session_expired", sessionId: "s1", data: {} });

    expect(bus.since("s1")).toEqual({ events: [], cursor: 0 });
  });

  test("the terminal event itself is still delivered live even though it isn't retained", () => {
    const bus = createEventBus({ clock });
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.kind));

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "session_revoked", sessionId: "s1", data: {} });

    expect(seen).toEqual(["app_event", "session_revoked"]);
  });

  test("session_revoked also discards the buffer, matching session_expired", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "session_revoked", sessionId: "s1", data: {} });

    expect(bus.since("s1")).toEqual({ events: [], cursor: 0 });
  });

  test("a throwing subscriber never breaks buffering or another subscriber", () => {
    const bus = createEventBus({ clock });
    const seen: string[] = [];

    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((event) => seen.push(event.kind));

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });

    expect(seen).toEqual(["app_event"]);
    expect(bus.since("s1").events).toHaveLength(1);
  });
});
