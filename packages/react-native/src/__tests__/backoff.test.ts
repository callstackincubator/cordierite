import { describe, expect, test } from "vitest";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  computeFullJitterBackoffMs,
} from "../client/backoff";

describe("computeFullJitterBackoffMs", () => {
  test("attempt 0 is bounded by [0, baseMs]", () => {
    expect(computeFullJitterBackoffMs(0, { random: () => 0 })).toBe(0);
    expect(
      computeFullJitterBackoffMs(0, { random: () => 0.999999 })
    ).toBeLessThan(BACKOFF_BASE_MS);
  });

  test("grows exponentially with the attempt number, before the cap", () => {
    // With a fixed random() the result is deterministic and proportional to 2^attempt.
    expect(computeFullJitterBackoffMs(0, { random: () => 1 })).toBe(
      BACKOFF_BASE_MS
    );
    expect(computeFullJitterBackoffMs(1, { random: () => 1 })).toBe(
      BACKOFF_BASE_MS * 2
    );
    expect(computeFullJitterBackoffMs(2, { random: () => 1 })).toBe(
      BACKOFF_BASE_MS * 4
    );
  });

  test("is capped at 30s regardless of how large the attempt number is", () => {
    expect(computeFullJitterBackoffMs(10, { random: () => 1 })).toBe(
      BACKOFF_CAP_MS
    );
    expect(computeFullJitterBackoffMs(100, { random: () => 1 })).toBe(
      BACKOFF_CAP_MS
    );
  });

  test("negative/fractional attempt numbers are clamped to attempt 0 behavior", () => {
    expect(computeFullJitterBackoffMs(-5, { random: () => 1 })).toBe(
      BACKOFF_BASE_MS
    );
  });

  test("supports injected base/cap overrides", () => {
    expect(
      computeFullJitterBackoffMs(5, {
        random: () => 1,
        baseMs: 100,
        capMs: 1_000,
      })
    ).toBe(1_000);
  });
});
