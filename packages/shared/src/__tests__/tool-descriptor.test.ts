import { describe, expect, test } from "vitest";

import {
  clampToolTimeoutMs,
  isObjectRootedSchema,
  isToolDescriptor,
  MAX_TOOL_DESCRIPTION_LENGTH,
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
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

  test("accepts a positive integer timeout_ms", () => {
    expect(isToolDescriptor({ ...valid(), timeout_ms: 60_000 })).toBe(true);
    expect(isToolDescriptor({ ...valid(), timeout_ms: 1 })).toBe(true);
  });

  test("accepts a descriptor that omits timeout_ms (older apps keep the daemon default)", () => {
    expect(isToolDescriptor(valid())).toBe(true);
    expect(isToolDescriptor({ ...valid(), timeout_ms: undefined })).toBe(true);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["a numeric string", "60000"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
  ])("rejects a timeout_ms that is %s", (_label, timeout_ms) => {
    expect(isToolDescriptor({ ...valid(), timeout_ms })).toBe(false);
  });

  test("ignores a camelCase timeoutMs: it is not the wire field, so it is neither honoured nor validated", () => {
    // Every protocol-defined descriptor field is snake_case. A camelCase key is just an unknown
    // extra: the guard must not read a deadline out of it, and must not reject the descriptor for
    // it either (an app is free to carry its own extras).
    const descriptor: unknown = { ...valid(), timeoutMs: 60_000 };
    expect(isToolDescriptor(descriptor)).toBe(true);

    if (isToolDescriptor(descriptor)) {
      expect(descriptor.timeout_ms).toBeUndefined();
    }

    // …not even when its value is one the snake_case field would have been rejected for.
    expect(isToolDescriptor({ ...valid(), timeoutMs: -1 })).toBe(true);
    expect(isToolDescriptor({ ...valid(), timeoutMs: "nonsense" })).toBe(true);
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

describe("clampToolTimeoutMs", () => {
  test("passes an in-range value through, truncated to whole milliseconds", () => {
    expect(clampToolTimeoutMs(60_000)).toBe(60_000);
    expect(clampToolTimeoutMs(1_500.9)).toBe(1_500);
  });

  test("clamps to the bounds the daemon enforces", () => {
    expect(clampToolTimeoutMs(0)).toBe(MIN_TOOL_TIMEOUT_MS);
    expect(clampToolTimeoutMs(-1)).toBe(MIN_TOOL_TIMEOUT_MS);
    expect(clampToolTimeoutMs(999)).toBe(MIN_TOOL_TIMEOUT_MS);
    expect(clampToolTimeoutMs(900_000)).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(clampToolTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TOOL_TIMEOUT_MS);
  });

  test("always returns a value the descriptor guard accepts", () => {
    for (const raw of [0, -1, 999, 1_000, 1_500.9, 60_000, 600_000, 900_000]) {
      expect(
        isToolDescriptor({
          name: "t",
          description: "d",
          timeout_ms: clampToolTimeoutMs(raw),
        }),
      ).toBe(true);
    }
  });
});
