import { describe, expect, test } from "vitest";

import {
  isObjectRootedSchema,
  isToolDescriptor,
  MAX_TOOL_DESCRIPTION_LENGTH,
  TOOL_NAME_PATTERN,
} from "../domains/tool-descriptor.js";

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

/**
 * The root-type gate behind the app-side dev warning for issue #26. Deliberately *not* the whole
 * MCP rule — the server re-checks with the SDK's own `ToolSchema` (`mcp/tool-mapping.ts`), which
 * this package cannot import — so the last case below pins that narrowness as intended, not a bug.
 */
describe("isObjectRootedSchema", () => {
  test('accepts a schema rooted at the literal type "object"', () => {
    expect(isObjectRootedSchema({ type: "object" })).toBe(true);
    expect(
      isObjectRootedSchema({
        type: "object",
        properties: { echoed: { type: "string" } },
        required: ["echoed"],
        additionalProperties: false,
      }),
    ).toBe(true);
  });

  test("accepts the shapes zod exports for a passthrough object and a record", () => {
    expect(isObjectRootedSchema({ type: "object", properties: {}, additionalProperties: {} })).toBe(true);
    expect(
      isObjectRootedSchema({
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: { type: "number" },
      }),
    ).toBe(true);
  });

  test.each([
    ["array", { type: "array", items: { type: "string" } }],
    ["string", { type: "string" }],
    ["number", { type: "number" }],
    ["boolean", { type: "boolean" }],
    ["null", { type: "null" }],
  ])("rejects a %s schema", (_label, schema) => {
    expect(isObjectRootedSchema(schema)).toBe(false);
  });

  test.each([
    ["union (anyOf)", { anyOf: [{ type: "object" }, { type: "object" }] }],
    ["discriminated union (oneOf)", { oneOf: [{ type: "object" }, { type: "object" }] }],
    ["intersection (allOf)", { allOf: [{ type: "object" }, { type: "object" }] }],
  ])("rejects a %s schema even though every branch is an object", (_label, schema) => {
    expect(isObjectRootedSchema(schema)).toBe(false);
  });

  test('rejects a union type that merely includes "object"', () => {
    expect(isObjectRootedSchema({ type: ["object", "null"] })).toBe(false);
  });

  test("rejects a schema with no type at all, and undefined", () => {
    expect(isObjectRootedSchema({})).toBe(false);
    expect(isObjectRootedSchema(undefined)).toBe(false);
  });

  test("is only the root-type gate: object-rooted shapes MCP still rejects pass here", () => {
    expect(isObjectRootedSchema({ type: "object", properties: { a: true } })).toBe(true);
    expect(isObjectRootedSchema({ type: "object", required: "name" })).toBe(true);
  });
});
