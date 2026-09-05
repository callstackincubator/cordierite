/**
 * `daemon/calls.ts`'s timeout arithmetic (issue #25). `clampTimeout` decides the deadline the
 * daemon actually enforces for a `tools.call`; `deriveCallTransportTimeoutMs` is what every caller
 * (the MCP server, `cordierite invoke`) sizes its own socket watchdog off, so that the daemon's
 * `tool_timeout` always wins the race and the caller reports the real error type.
 */

import { describe, expect, test } from "vitest";

import {
  CALL_TRANSPORT_TIMEOUT_SLACK_MS,
  clampTimeout,
  DEFAULT_CALL_TIMEOUT_MS,
  deriveCallTransportTimeoutMs,
  MAX_CALL_TIMEOUT_MS,
  MIN_CALL_TIMEOUT_MS,
} from "../daemon/calls.js";

describe("clampTimeout", () => {
  test("falls back to the daemon default when unset or not finite", () => {
    expect(clampTimeout(undefined)).toBe(DEFAULT_CALL_TIMEOUT_MS);
    expect(clampTimeout(Number.NaN)).toBe(DEFAULT_CALL_TIMEOUT_MS);
    expect(clampTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CALL_TIMEOUT_MS);
  });

  test("passes an in-range value through, truncated to whole milliseconds", () => {
    expect(clampTimeout(60_000)).toBe(60_000);
    expect(clampTimeout(1_500.9)).toBe(1_500);
  });

  test("clamps to the documented bounds", () => {
    expect(clampTimeout(0)).toBe(MIN_CALL_TIMEOUT_MS);
    expect(clampTimeout(-1)).toBe(MIN_CALL_TIMEOUT_MS);
    expect(clampTimeout(MAX_CALL_TIMEOUT_MS + 1)).toBe(MAX_CALL_TIMEOUT_MS);
    expect(clampTimeout(Number.MAX_SAFE_INTEGER)).toBe(MAX_CALL_TIMEOUT_MS);
  });
});

describe("deriveCallTransportTimeoutMs", () => {
  test("is the enforced deadline plus slack", () => {
    expect(deriveCallTransportTimeoutMs(undefined)).toBe(DEFAULT_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
    expect(deriveCallTransportTimeoutMs(60_000)).toBe(60_000 + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
  });

  test("adds slack to the clamped value, not the raw one", () => {
    expect(deriveCallTransportTimeoutMs(500)).toBe(MIN_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
    // Clamping first is what keeps this inside Node's ~24.8-day timer range: an unclamped
    // MAX_SAFE_INTEGER would overflow and fire the watchdog immediately.
    const derived = deriveCallTransportTimeoutMs(Number.MAX_SAFE_INTEGER);
    expect(derived).toBe(MAX_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
    expect(derived).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  test("always exceeds the deadline the daemon will enforce for the same input", () => {
    for (const timeoutMs of [undefined, 0, 1_000, 10_000, 60_000, 600_000, 900_000]) {
      expect(deriveCallTransportTimeoutMs(timeoutMs)).toBeGreaterThan(clampTimeout(timeoutMs));
    }
  });
});
