/**
 * The MCP tool mapper's schema gate (issue #26). A client validates the whole `tools/list` result
 * against the SDK's `ToolSchema`, so a single entry it rejects takes the entire list down. Every
 * fixture below is asserted against that same `ToolSchema` in the first describe block, so these
 * tests cannot quietly drift from what the SDK actually accepts if the pinned version changes.
 */

import { describe, expect, test, vi } from "vitest";

import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ToolDescriptor, ToolSchemaDescriptor } from "@cordierite/shared";

import { createMcpToolMapper, emitsMcpOutputSchema, type McpToolMapper } from "../mcp/tool-mapping.js";
import type { NamespacedTool } from "../mcp/tool-namespace.js";

const EMPTY_OBJECT_SCHEMA = { type: "object", additionalProperties: true };

/** What zod v4.4.3's exporter emits, verified against the real zod, by construct. */
const OBJECT_SCHEMA: ToolSchemaDescriptor = {
  type: "object",
  properties: { echoed: { type: "string" } },
  required: ["echoed"],
  additionalProperties: false,
};
/** `z.object({}).passthrough()` / `z.looseObject({})`. */
const PASSTHROUGH_SCHEMA: ToolSchemaDescriptor = { type: "object", properties: {}, additionalProperties: {} };
/** `z.record(z.string(), z.number())`. */
const RECORD_SCHEMA: ToolSchemaDescriptor = {
  type: "object",
  propertyNames: { type: "string" },
  additionalProperties: { type: "number" },
};
const ARRAY_SCHEMA: ToolSchemaDescriptor = { type: "array", items: { type: "string" } };
const STRING_SCHEMA: ToolSchemaDescriptor = { type: "string" };
const NUMBER_SCHEMA: ToolSchemaDescriptor = { type: "number" };
const BOOLEAN_SCHEMA: ToolSchemaDescriptor = { type: "boolean" };
const NULL_SCHEMA: ToolSchemaDescriptor = { type: "null" };
/** `z.union([z.object(...), z.object(...)])`, and equally `z.object(...).nullable()` — `anyOf`,
 * no root `type`. */
const UNION_SCHEMA: ToolSchemaDescriptor = { anyOf: [{ type: "object" }, { type: "object" }] };
/** `z.discriminatedUnion(...)` of objects — `oneOf`, still no root `type`. */
const DISCRIMINATED_UNION_SCHEMA: ToolSchemaDescriptor = { oneOf: [{ type: "object" }, { type: "object" }] };
/** `z.intersection(z.object(...), z.object(...))` — `allOf`, still no root `type`. */
const INTERSECTION_SCHEMA: ToolSchemaDescriptor = { allOf: [{ type: "object" }, { type: "object" }] };

/** Not zod exports — hand-written or third-party-exporter shapes that are object-*rooted* yet
 * still rejected, which is why the gate is the SDK schema rather than a `type === "object"`
 * check. */
const BOOLEAN_SUBSCHEMA: ToolSchemaDescriptor = { type: "object", properties: { a: true } };
const STRING_SUBSCHEMA: ToolSchemaDescriptor = { type: "object", properties: { a: "string" } };
const SCALAR_REQUIRED: ToolSchemaDescriptor = { type: "object", required: "name" };
const NULLABLE_OBJECT_TYPE: ToolSchemaDescriptor = { type: ["object", "null"] };

const ACCEPTED: Array<[string, ToolSchemaDescriptor]> = [
  ["object", OBJECT_SCHEMA],
  ["passthrough object", PASSTHROUGH_SCHEMA],
  ["record", RECORD_SCHEMA],
];

const REJECTED: Array<[string, ToolSchemaDescriptor]> = [
  ["array", ARRAY_SCHEMA],
  ["string", STRING_SCHEMA],
  ["number", NUMBER_SCHEMA],
  ["boolean", BOOLEAN_SCHEMA],
  ["null", NULL_SCHEMA],
  ["union (anyOf)", UNION_SCHEMA],
  ["discriminated union of objects (oneOf)", DISCRIMINATED_UNION_SCHEMA],
  ["intersection of objects (allOf)", INTERSECTION_SCHEMA],
  ["object with a boolean subschema", BOOLEAN_SUBSCHEMA],
  ["object with a string subschema", STRING_SUBSCHEMA],
  ["object with a scalar required", SCALAR_REQUIRED],
  ['type ["object", "null"]', NULLABLE_OBJECT_TYPE],
];

const namespacedTool = (descriptor: Partial<ToolDescriptor>, selector = "pixel-8"): NamespacedTool => ({
  mcpName: descriptor.name ?? "tool",
  selector,
  descriptor: { name: "tool", description: "A test tool.", ...descriptor },
  policy: "allow",
});

/** A mapper whose notices are captured instead of printed — no console spying, no module state. */
const mapperWithNotices = (): { map: McpToolMapper; notices: string[] } => {
  const notices: string[] = [];
  return { map: createMcpToolMapper((message) => notices.push(message)), notices };
};

const map = (descriptor: Partial<ToolDescriptor>) => mapperWithNotices().map(namespacedTool(descriptor), false);

describe("the fixtures match what the pinned MCP SDK accepts", () => {
  test.each(ACCEPTED)("ToolSchema accepts a %s schema in both slots", (_label, schema) => {
    expect(ToolSchema.safeParse({ name: "probe", inputSchema: schema }).success).toBe(true);
    expect(
      ToolSchema.safeParse({ name: "probe", inputSchema: { type: "object" }, outputSchema: schema }).success,
    ).toBe(true);
  });

  test.each(REJECTED)("ToolSchema rejects a %s schema in both slots", (_label, schema) => {
    expect(ToolSchema.safeParse({ name: "probe", inputSchema: schema }).success).toBe(false);
    expect(
      ToolSchema.safeParse({ name: "probe", inputSchema: { type: "object" }, outputSchema: schema }).success,
    ).toBe(false);
  });
});

describe("outputSchema is emitted only when the SDK would accept it", () => {
  test.each(ACCEPTED)("keeps a %s output schema verbatim", (_label, schema) => {
    expect(map({ output_schema: schema }).outputSchema).toEqual(schema);
    expect(emitsMcpOutputSchema(schema)).toBe(true);
  });

  test.each(REJECTED)("omits a %s output schema", (_label, schema) => {
    const mapped = map({ output_schema: schema });

    expect(mapped).not.toHaveProperty("outputSchema");
    expect(mapped.outputSchema).toBeUndefined();
    expect(emitsMcpOutputSchema(schema)).toBe(false);
  });

  test("the tool itself stays listed, named and described when its output schema is dropped", () => {
    const mapped = map({ name: "list-todos", description: "Lists todos.", output_schema: ARRAY_SCHEMA });

    expect(mapped.name).toBe("list-todos");
    expect(mapped.description).toBe("Lists todos.");
    expect(mapped.inputSchema).toEqual(EMPTY_OBJECT_SCHEMA);
  });

  test("omits outputSchema when the descriptor has none", () => {
    expect(map({}).outputSchema).toBeUndefined();
    expect(emitsMcpOutputSchema(undefined)).toBe(false);
  });

  test("every emitted tool passes the SDK's own ToolSchema", () => {
    for (const [, schema] of [...ACCEPTED, ...REJECTED]) {
      const mapped = map({ name: "probe", input_schema: schema, output_schema: schema });

      expect(ToolSchema.safeParse(mapped).success).toBe(true);
    }
  });
});

describe("inputSchema always ends up something MCP accepts", () => {
  test.each(ACCEPTED)("keeps a %s input schema verbatim", (_label, schema) => {
    expect(map({ input_schema: schema }).inputSchema).toEqual(schema);
  });

  test.each(REJECTED)("falls back to the permissive empty object schema for a %s input schema", (_label, schema) => {
    expect(map({ input_schema: schema }).inputSchema).toEqual(EMPTY_OBJECT_SCHEMA);
  });

  test("falls back to the permissive empty object schema when there is no input schema", () => {
    expect(map({}).inputSchema).toEqual(EMPTY_OBJECT_SCHEMA);
  });
});

describe("degradation notices", () => {
  test("warns once per tool however often tools/list is answered", () => {
    const { map: mapper, notices } = mapperWithNotices();
    const tool = namespacedTool({ name: "list-todos", output_schema: ARRAY_SCHEMA });

    mapper(tool, false);
    mapper(tool, false);
    mapper(tool, false);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("list-todos");
    expect(notices[0]).toContain("output schema");
  });

  test("names the tool as the agent sees it, and says why MCP rejected the schema", () => {
    const { map: mapper, notices } = mapperWithNotices();

    mapper(
      {
        mcpName: "pixel-8__lies",
        selector: "pixel-8",
        descriptor: { name: "lies", description: "d", output_schema: SCALAR_REQUIRED },
        policy: "allow",
      },
      false,
    );

    expect(notices[0]).toContain("pixel-8__lies");
    expect(notices[0]).toContain("required");
  });

  test("two sessions exposing the same broken tool each get a notice", () => {
    const { map: mapper, notices } = mapperWithNotices();

    mapper(namespacedTool({ name: "list-todos", output_schema: ARRAY_SCHEMA }, "pixel-8"), false);
    mapper(namespacedTool({ name: "list-todos", output_schema: ARRAY_SCHEMA }, "iphone-16"), false);

    expect(notices).toHaveLength(2);
  });

  test("re-registering the same tool with a differently broken schema warns again", () => {
    const { map: mapper, notices } = mapperWithNotices();

    mapper(namespacedTool({ name: "list-todos", output_schema: ARRAY_SCHEMA }), false);
    mapper(namespacedTool({ name: "list-todos", output_schema: STRING_SCHEMA }), false);

    expect(notices).toHaveLength(2);
  });

  test("the single-to-multi session flip, which rewrites mcpName, does not re-warn", () => {
    const { map: mapper, notices } = mapperWithNotices();
    const descriptor = { name: "list-todos", description: "d", output_schema: ARRAY_SCHEMA };

    mapper({ mcpName: "list-todos", selector: "pixel-8", descriptor, policy: "allow" }, false);
    mapper({ mcpName: "pixel-8__list-todos", selector: "pixel-8", descriptor, policy: "allow" }, false);

    expect(notices).toHaveLength(1);
  });

  test("warns separately for the input and the output side of one tool", () => {
    const { map: mapper, notices } = mapperWithNotices();

    mapper(namespacedTool({ name: "a", input_schema: STRING_SCHEMA, output_schema: ARRAY_SCHEMA }), false);

    expect(notices).toHaveLength(2);
    expect(notices.filter((notice) => notice.includes("input schema"))).toHaveLength(1);
    expect(notices.filter((notice) => notice.includes("output schema"))).toHaveLength(1);
  });

  test("remembers a bounded number of notices, so a schema built from live data cannot grow it forever", () => {
    const { map: mapper, notices } = mapperWithNotices();

    // Each iteration is a *distinct* broken schema for the same tool, which is what an app
    // building a schema from fetched rows would produce. Far past the 256-key cap.
    for (let index = 0; index < 400; index += 1) {
      mapper(namespacedTool({ name: "from-live-data", output_schema: { type: "string", const: `v${index}` } }), false);
    }

    expect(notices).toHaveLength(400);

    // The oldest keys have been evicted, so the very first schema warns again...
    mapper(namespacedTool({ name: "from-live-data", output_schema: { type: "string", const: "v0" } }), false);
    expect(notices).toHaveLength(401);

    // ...while a recent one is still remembered and stays quiet.
    mapper(namespacedTool({ name: "from-live-data", output_schema: { type: "string", const: "v399" } }), false);
    expect(notices).toHaveLength(401);
  });

  test("the default sink writes to stderr with the same prefix as the rest of the MCP server", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      createMcpToolMapper()(namespacedTool({ name: "list-todos", output_schema: ARRAY_SCHEMA }), false);

      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]![0])).toMatch(/^cordierite mcp: /);
    } finally {
      stderr.mockRestore();
    }
  });

  test("stays silent for accepted and absent schemas", () => {
    const { map: mapper, notices } = mapperWithNotices();

    mapper(namespacedTool({ name: "quiet", input_schema: OBJECT_SCHEMA, output_schema: RECORD_SCHEMA }), false);
    mapper(namespacedTool({ name: "also-quiet" }), false);

    expect(notices).toEqual([]);
  });
});

describe("unrelated mapping is unchanged", () => {
  test("annotations and the requiresUserInteraction meta still map alongside a dropped output schema", () => {
    const { map: mapper } = mapperWithNotices();
    const mapped = mapper(
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

describe("the requiresUserInteraction flag", () => {
  /**
   * `mcp/server.ts` folds the elicitation-channel preference into the mapper's boolean before
   * calling it (never emit the flag once elicitation is preferred, so a "prompt" tool cannot arm
   * both consent channels for one call — ARCHITECTURE.md §12 / issues #10 & #14). This exercises
   * the mapper's side of that contract, without a daemon or an MCP client.
   */
  const promptTool = (policy: NamespacedTool["policy"]): NamespacedTool => ({
    mcpName: "deleteAll",
    selector: "pixel-8",
    descriptor: { name: "deleteAll", description: "Deletes everything." },
    policy,
  });

  test('a "prompt" tool gets the flag when the caller says to emit it', () => {
    expect(mapperWithNotices().map(promptTool("prompt"), true)._meta).toEqual({
      "anthropic/requiresUserInteraction": true,
    });
  });

  test('a "prompt" tool gets no flag when the caller says not to — e.g. elicitation was preferred for this connection (issue #10)', () => {
    expect(mapperWithNotices().map(promptTool("prompt"), false)._meta).toBeUndefined();
  });

  test('an "allow" tool never gets the flag, even when the caller would otherwise emit it', () => {
    expect(mapperWithNotices().map(promptTool("allow"), true)._meta).toBeUndefined();
  });

  test('a "deny" tool never gets the flag either', () => {
    expect(mapperWithNotices().map(promptTool("deny"), true)._meta).toBeUndefined();
  });
});
