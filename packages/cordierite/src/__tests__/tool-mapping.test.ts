/**
 * `toMcpTool`'s schema gate (issue #26). MCP's `Tool` declares both `inputSchema.type` and
 * `outputSchema.type` as the literal `"object"` and clients validate the whole `tools/list`
 * result, so a single entry rooted at anything else takes the entire list down. The JSON Schema
 * literals below are what zod v4's exporter actually emits for the constructs named in each case.
 */

import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import type { ToolDescriptor, ToolSchemaDescriptor } from "@cordierite/shared";

import { resetToolMappingWarnings, toMcpTool } from "../mcp/tool-mapping.js";
import type { NamespacedTool } from "../mcp/tool-namespace.js";

const EMPTY_OBJECT_SCHEMA = { type: "object", additionalProperties: true };

/** The notices go to the real stderr; capture them so the suite stays quiet and so the
 * dedup assertions below have something to count. */
let stderr: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {}) as unknown as typeof stderr;
});

afterEach(() => {
  // Module-level dedup sets would otherwise leak the first case's warning into every later one.
  resetToolMappingWarnings();
  vi.restoreAllMocks();
});

const namespacedTool = (descriptor: Partial<ToolDescriptor>): NamespacedTool => ({
  mcpName: descriptor.name ?? "tool",
  selector: "pixel-8",
  descriptor: { name: "tool", description: "A test tool.", ...descriptor },
  policy: "allow",
});

const map = (descriptor: Partial<ToolDescriptor>) => toMcpTool(namespacedTool(descriptor), false);

/** zod v4 exports, by construct. */
const OBJECT_SCHEMA: ToolSchemaDescriptor = {
  type: "object",
  properties: { echoed: { type: "string" } },
  required: ["echoed"],
  additionalProperties: false,
};
const PASSTHROUGH_SCHEMA: ToolSchemaDescriptor = { type: "object", properties: {}, additionalProperties: true };
const RECORD_SCHEMA: ToolSchemaDescriptor = { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "number" } };
const ARRAY_SCHEMA: ToolSchemaDescriptor = { type: "array", items: { type: "string" } };
const STRING_SCHEMA: ToolSchemaDescriptor = { type: "string" };
const NUMBER_SCHEMA: ToolSchemaDescriptor = { type: "number" };
const BOOLEAN_SCHEMA: ToolSchemaDescriptor = { type: "boolean" };
const NULL_SCHEMA: ToolSchemaDescriptor = { type: "null" };
/** `z.union([z.object(...), z.object(...)])` — `anyOf`, no root `type`. */
const UNION_SCHEMA: ToolSchemaDescriptor = { anyOf: [{ type: "object" }, { type: "object" }] };
/** `z.discriminatedUnion(...)` of objects — `oneOf`, still no root `type`. */
const DISCRIMINATED_UNION_SCHEMA: ToolSchemaDescriptor = { oneOf: [{ type: "object" }, { type: "object" }] };
/** A `type` that *includes* "object" is still not the literal MCP requires. */
const NULLABLE_OBJECT_SCHEMA: ToolSchemaDescriptor = { type: ["object", "null"] };

describe("toMcpTool: outputSchema is emitted only when object-rooted", () => {
  test.each([
    ["object", OBJECT_SCHEMA],
    ["passthrough object", PASSTHROUGH_SCHEMA],
    ["record", RECORD_SCHEMA],
  ])("keeps an object-rooted %s output schema verbatim", (_label, schema) => {
    expect(map({ output_schema: schema }).outputSchema).toEqual(schema);
  });

  test.each([
    ["array", ARRAY_SCHEMA],
    ["string", STRING_SCHEMA],
    ["number", NUMBER_SCHEMA],
    ["boolean", BOOLEAN_SCHEMA],
    ["null", NULL_SCHEMA],
    ["union", UNION_SCHEMA],
    ["discriminated union of objects", DISCRIMINATED_UNION_SCHEMA],
    ["nullable object", NULLABLE_OBJECT_SCHEMA],
  ])("omits a non-object-rooted %s output schema", (_label, schema) => {
    const mapped = map({ output_schema: schema });

    expect(mapped).not.toHaveProperty("outputSchema");
    expect(mapped.outputSchema).toBeUndefined();
  });

  test("the tool itself stays listed, named and described when its output schema is dropped", () => {
    const mapped = map({ name: "list-todos", description: "Lists todos.", output_schema: ARRAY_SCHEMA });

    expect(mapped.name).toBe("list-todos");
    expect(mapped.description).toBe("Lists todos.");
    expect(mapped.inputSchema).toEqual(EMPTY_OBJECT_SCHEMA);
  });

  test("omits outputSchema when the descriptor has none", () => {
    expect(map({}).outputSchema).toBeUndefined();
  });
});

describe("toMcpTool: inputSchema always ends up object-rooted", () => {
  test("keeps an object-rooted input schema verbatim", () => {
    expect(map({ input_schema: OBJECT_SCHEMA }).inputSchema).toEqual(OBJECT_SCHEMA);
  });

  test.each([
    ["array", ARRAY_SCHEMA],
    ["string", STRING_SCHEMA],
    ["union", UNION_SCHEMA],
  ])("falls back to the permissive empty object schema for a %s input schema", (_label, schema) => {
    expect(map({ input_schema: schema }).inputSchema).toEqual(EMPTY_OBJECT_SCHEMA);
  });

  test("falls back to the permissive empty object schema when there is no input schema", () => {
    expect(map({}).inputSchema).toEqual(EMPTY_OBJECT_SCHEMA);
  });
});

describe("toMcpTool: stderr notices", () => {
  test("warns once per tool name on stderr when an output schema is dropped, however often tools/list is answered", () => {
    map({ name: "list-todos", output_schema: ARRAY_SCHEMA });
    map({ name: "list-todos", output_schema: ARRAY_SCHEMA });
    map({ name: "list-todos", output_schema: ARRAY_SCHEMA });

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).toContain("list-todos");
    expect(String(stderr.mock.calls[0]![0])).toContain("output schema");
  });

  test("warns separately for a different tool, and separately for input and output on the same tool", () => {
    map({ name: "a", output_schema: ARRAY_SCHEMA });
    map({ name: "b", output_schema: ARRAY_SCHEMA });
    map({ name: "a", input_schema: STRING_SCHEMA });

    expect(stderr).toHaveBeenCalledTimes(3);
  });

  test("stays silent for object-rooted and absent schemas", () => {
    map({ name: "quiet", input_schema: OBJECT_SCHEMA, output_schema: OBJECT_SCHEMA });
    map({ name: "also-quiet" });

    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("toMcpTool: unrelated mapping is unchanged", () => {
  test("annotations and the requiresUserInteraction meta still map alongside a dropped output schema", () => {
    const mapped = toMcpTool(
      {
        mcpName: "pixel-8__list-todos",
        selector: "pixel-8",
        descriptor: {
          name: "list-todos",
          description: "Lists todos.",
          output_schema: ARRAY_SCHEMA,
          annotations: { readOnlyHint: true },
        },
        policy: "prompt",
      },
      true,
    );

    expect(mapped.name).toBe("pixel-8__list-todos");
    expect(mapped.annotations).toEqual({ readOnlyHint: true });
    expect(mapped._meta).toEqual({ "anthropic/requiresUserInteraction": true });
    expect(mapped.outputSchema).toBeUndefined();
  });
});
