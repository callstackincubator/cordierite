import { describe, expect, test } from "vitest";

import { isToolDescriptor, MAX_TOOL_DESCRIPTION_LENGTH, TOOL_NAME_PATTERN } from "../domains/tool-descriptor.js";

const valid = () => ({
  name: "read_file",
  description: "Reads a file.",
});

describe("isToolDescriptor", () => {
  test("accepts the minimal required shape", () => {
    expect(isToolDescriptor(valid())).toBe(true);
  });

  test("accepts optional schemas, and annotations", () => {
    expect(
      isToolDescriptor({
        ...valid(),
        input_schema: { type: "object" },
        output_schema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      }),
    ).toBe(true);
  });

  test("accepts partial annotations", () => {
    expect(isToolDescriptor({ ...valid(), annotations: { readOnlyHint: true } })).toBe(true);
  });

  test.each([
    ["empty string", ""],
    ["too long", "a".repeat(65)],
    ["invalid characters", "read file!"],
    ["invalid characters (dot)", "read.file"],
  ])("rejects a name that is %s", (_label, name) => {
    expect(isToolDescriptor({ ...valid(), name })).toBe(false);
  });

  test("name pattern accepts the documented alphabet", () => {
    expect(TOOL_NAME_PATTERN.test("A-Za-z0-9_-")).toBe(true);
    expect(TOOL_NAME_PATTERN.test("a".repeat(64))).toBe(true);
    expect(TOOL_NAME_PATTERN.test("a".repeat(65))).toBe(false);
  });

  test("rejects missing description", () => {
    const { description: _description, ...rest } = valid();
    expect(isToolDescriptor(rest)).toBe(false);
  });

  test("rejects a non-string description", () => {
    expect(isToolDescriptor({ ...valid(), description: 42 })).toBe(false);
  });

  test("rejects an oversized description", () => {
    expect(isToolDescriptor({ ...valid(), description: "a".repeat(MAX_TOOL_DESCRIPTION_LENGTH + 1) })).toBe(
      false,
    );
  });

  test("rejects a non-object input_schema", () => {
    expect(isToolDescriptor({ ...valid(), input_schema: "not-an-object" })).toBe(false);
  });

  test("rejects a non-object output_schema", () => {
    expect(isToolDescriptor({ ...valid(), output_schema: ["not", "an", "object"] })).toBe(false);
  });

  test("rejects annotation keys outside the three boolean hints", () => {
    expect(isToolDescriptor({ ...valid(), annotations: { readOnlyHint: true, extra: true } })).toBe(false);
  });

  test("rejects a non-boolean annotation value", () => {
    expect(isToolDescriptor({ ...valid(), annotations: { readOnlyHint: "yes" } })).toBe(false);
  });

  test("rejects null", () => {
    expect(isToolDescriptor(null)).toBe(false);
  });

  test("rejects an array", () => {
    expect(isToolDescriptor(["not", "an", "object"])).toBe(false);
  });

  test("rejects a bare primitive", () => {
    expect(isToolDescriptor("not-an-object")).toBe(false);
  });
});
