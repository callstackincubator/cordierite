/**
 * Pure unit test for `mcp/events-tool.ts`'s `clampWaitForEventTimeoutMs` (issue #6's "Cap
 * timeoutMs server-side below the idle window rather than trusting the caller"). No daemon, no
 * socket — the actual bounds (120s default, 1500000ms cap) are minutes long, so this exercises the
 * boundary math directly rather than waiting either one out through the full MCP tool.
 */

import { describe, expect, test } from "vitest";

import { clampWaitForEventTimeoutMs } from "../mcp/events-tool.js";

describe("clampWaitForEventTimeoutMs", () => {
  test("defaults to 120000ms when no timeoutMs is given", () => {
    expect(clampWaitForEventTimeoutMs(undefined)).toBe(120_000);
  });

  test("passes a requested value through unchanged when it's under the cap", () => {
    expect(clampWaitForEventTimeoutMs(5_000)).toBe(5_000);
  });

  test("caps a requested value at 1500000ms (25 minutes), never trusting the caller past it", () => {
    expect(clampWaitForEventTimeoutMs(1_500_000)).toBe(1_500_000);
    expect(clampWaitForEventTimeoutMs(10_000_000)).toBe(1_500_000);
    expect(clampWaitForEventTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(1_500_000);
  });
});
