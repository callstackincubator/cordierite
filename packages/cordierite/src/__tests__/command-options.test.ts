import { describe, expect, test } from "vitest";

import {
  parseJsonInputOption,
  parseNonNegativeIntegerOption,
  parsePositiveIntegerOption,
  splitOptionalSelector,
  splitOptionalSelectorAndTarget,
  splitSelectorAndRequiredTarget,
} from "../cli/command-options.js";

describe("parsePositiveIntegerOption", () => {
  test("passes through undefined", () => {
    expect(parsePositiveIntegerOption(undefined, "--ttl")).toBeUndefined();
  });

  test("accepts a numeric string", () => {
    expect(parsePositiveIntegerOption("60", "--ttl")).toBe(60);
  });

  test("rejects zero, negative, and non-numeric values", () => {
    expect(() => parsePositiveIntegerOption("0", "--ttl")).toThrow(/positive integer/u);
    expect(() => parsePositiveIntegerOption("-5", "--ttl")).toThrow(/positive integer/u);
    expect(() => parsePositiveIntegerOption("abc", "--ttl")).toThrow(/positive integer/u);
  });
});

describe("parseNonNegativeIntegerOption", () => {
  test("passes through undefined", () => {
    expect(parseNonNegativeIntegerOption(undefined, "--since")).toBeUndefined();
  });

  test("accepts a numeric string, including zero", () => {
    expect(parseNonNegativeIntegerOption("0", "--since")).toBe(0);
    expect(parseNonNegativeIntegerOption("42", "--since")).toBe(42);
  });

  test("rejects negative, non-integer, and non-numeric values", () => {
    expect(() => parseNonNegativeIntegerOption("-1", "--since")).toThrow(/non-negative integer/u);
    expect(() => parseNonNegativeIntegerOption("1.5", "--since")).toThrow(/non-negative integer/u);
    expect(() => parseNonNegativeIntegerOption("abc", "--since")).toThrow(/non-negative integer/u);
  });
});

describe("parseJsonInputOption", () => {
  test("parses a valid JSON object", () => {
    expect(parseJsonInputOption('{"text":"hi"}')).toEqual({ text: "hi" });
  });

  test("requires --input to be present", () => {
    expect(() => parseJsonInputOption(undefined)).toThrow(/"--input" is required/u);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseJsonInputOption("{not-json")).toThrow(/valid JSON/u);
  });

  test("rejects non-object JSON (arrays, scalars)", () => {
    expect(() => parseJsonInputOption("[1,2,3]")).toThrow(/JSON object/u);
    expect(() => parseJsonInputOption("42")).toThrow(/JSON object/u);
    expect(() => parseJsonInputOption("null")).toThrow(/JSON object/u);
  });
});

describe("splitSelectorAndRequiredTarget (invoke [selector] <tool>)", () => {
  test("one arg: no selector, target is the sole arg", () => {
    expect(splitSelectorAndRequiredTarget(["echo"], "invoke")).toEqual({ target: "echo" });
  });

  test("two args: selector then target", () => {
    expect(splitSelectorAndRequiredTarget(["pixel-8", "echo"], "invoke")).toEqual({
      selector: "pixel-8",
      target: "echo",
    });
  });

  test("zero args: usage error (target is required)", () => {
    expect(() => splitSelectorAndRequiredTarget([], "invoke")).toThrow(/Usage/u);
  });

  test("three or more args: usage error", () => {
    expect(() => splitSelectorAndRequiredTarget(["a", "b", "c"], "invoke")).toThrow(/Usage/u);
  });
});

describe("splitOptionalSelector (revoke [selector] / events [selector])", () => {
  test("zero args", () => {
    expect(splitOptionalSelector([], "revoke")).toEqual({ selector: undefined });
  });

  test("one arg", () => {
    expect(splitOptionalSelector(["pixel-8"], "revoke")).toEqual({ selector: "pixel-8" });
  });

  test("two or more args: usage error", () => {
    expect(() => splitOptionalSelector(["a", "b"], "revoke")).toThrow(/Usage/u);
  });
});

describe("splitOptionalSelectorAndTarget (tools [selector] [name])", () => {
  test("zero args", () => {
    expect(splitOptionalSelectorAndTarget([], "tools")).toEqual({});
  });

  test("one arg: ambiguous, comes back as selectorOrTarget", () => {
    expect(splitOptionalSelectorAndTarget(["echo"], "tools")).toEqual({ selectorOrTarget: "echo" });
  });

  test("two args: selector then target, unambiguous", () => {
    expect(splitOptionalSelectorAndTarget(["pixel-8", "echo"], "tools")).toEqual({
      selector: "pixel-8",
      target: "echo",
    });
  });

  test("three or more args: usage error", () => {
    expect(() => splitOptionalSelectorAndTarget(["a", "b", "c"], "tools")).toThrow(/Usage/u);
  });
});
