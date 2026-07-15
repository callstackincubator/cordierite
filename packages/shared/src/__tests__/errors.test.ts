import { describe, expect, test } from "bun:test";

import { ERROR_TYPES, isKnownErrorType, isToolErrorType, TOOL_ERROR_TYPES } from "../domains/errors.js";

describe("isKnownErrorType", () => {
  test.each(ERROR_TYPES.map((type) => [type] as const))("accepts %s", (type) => {
    expect(isKnownErrorType(type)).toBe(true);
  });

  test("rejects an unknown string", () => {
    expect(isKnownErrorType("something_else")).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isKnownErrorType(42)).toBe(false);
    expect(isKnownErrorType(null)).toBe(false);
    expect(isKnownErrorType(undefined)).toBe(false);
  });
});

describe("isToolErrorType", () => {
  test.each(TOOL_ERROR_TYPES.map((type) => [type] as const))("accepts %s", (type) => {
    expect(isToolErrorType(type)).toBe(true);
  });

  test("rejects a known error type outside the tool_* subset", () => {
    expect(isToolErrorType("no_session")).toBe(false);
    expect(isToolErrorType("policy_denied")).toBe(false);
  });
});
