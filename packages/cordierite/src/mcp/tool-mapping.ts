/**
 * Maps a `NamespacedTool` (daemon `ToolDescriptor` + resolved external name) onto the MCP SDK's
 * `Tool` wire shape (ARCHITECTURE.md §9/§7): `description` maps directly and `annotations` map
 * verbatim, while `input_schema`/`output_schema` are emitted only if the SDK's own `ToolSchema`
 * accepts them (issue #26) — a rejected `input_schema` is replaced with an empty, permissive
 * object schema and a rejected `output_schema` is dropped entirely. Either way the tool stays
 * listed and callable: one app-side schema MCP cannot represent must never take down the whole
 * `tools/list`.
 *
 * The gate is the SDK schema itself rather than a hand-rolled `type === "object"` check, because
 * MCP constrains more than the root type — `properties` must be a record of *object* subschemas
 * (the JSON Schema shorthand `properties: { a: true }` is rejected) and `required` must be an
 * array. Any of those makes a client reject the entire `tools/list` result, so the only safe
 * predicate is the one the client will actually apply.
 *
 * A tool whose effective policy is `"prompt"` (ARCHITECTURE.md §12) gets
 * `_meta["anthropic/requiresUserInteraction"] = true` — but only when the connected client is
 * known to enforce it (issue #14); emitting the flag for a client that ignores it would create a
 * false sense of security, so the caller must confirm that separately and pass it in.
 */

import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ToolSchemaDescriptor } from "@cordierite/shared";

import type { NamespacedTool } from "./tool-namespace.js";

/** MCP requires `inputSchema.type === "object"`; an app that registered a tool without a schema
 * gets the most permissive possible one rather than an MCP-invalid `{}`. */
const EMPTY_OBJECT_SCHEMA = { type: "object", additionalProperties: true } as const;

export type McpToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

type SchemaSlot = "input" | "output";

/**
 * Why the SDK's `ToolSchema` would reject `schema` in this slot, or `undefined` when it accepts
 * it. The probe wraps the schema in an otherwise-minimal valid `Tool` so the only thing under test
 * is the schema; the returned reason is the first issue, with the leading `inputSchema`/
 * `outputSchema` path segment stripped so the message reads from the app author's point of view.
 */
const mcpSchemaRejection = (schema: ToolSchemaDescriptor, slot: SchemaSlot): string | undefined => {
  const probe =
    slot === "input"
      ? { name: "probe", inputSchema: schema }
      : { name: "probe", inputSchema: EMPTY_OBJECT_SCHEMA, outputSchema: schema };

  const parsed = ToolSchema.safeParse(probe);

  if (parsed.success) {
    return undefined;
  }

  const issue = parsed.error.issues[0];

  if (!issue) {
    return "it does not match MCP's tool schema";
  }

  const path = issue.path.slice(1).join(".");

  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
};

/**
 * Whether `tools/list` will carry an `outputSchema` for this descriptor. `server.ts`'s success
 * path shares this predicate so the "did we advertise a schema?" and "must this result carry
 * `structuredContent`?" decisions can never disagree — a client demands the latter exactly when
 * it saw the former.
 */
export const emitsMcpOutputSchema = (schema: ToolSchemaDescriptor | undefined): boolean => {
  return schema !== undefined && mcpSchemaRejection(schema, "output") === undefined;
};

/** stderr only — stdout carries the MCP transport's protocol frames (ARCHITECTURE.md §9). */
const defaultWarn = (message: string): void => {
  console.error(`[cordierite] ${message}`);
};

export type McpToolMapper = (tool: NamespacedTool, clientHonorsRequiresUserInteraction: boolean) => McpToolSchema;

/**
 * Builds a mapper with its own degradation-notice dedup, so nothing here is module state and no
 * reset hook has to be exported for tests: a server owns one mapper for its lifetime, and a test
 * owns one per case. `warn` defaults to stderr and exists so a test can capture notices without
 * spying on the console.
 *
 * Notices dedupe on session + tool name + the offending schema, because `tools/list` is
 * re-answered on every client request and on every `notifications/tools/list_changed` refresh. Two
 * devices exposing the same broken tool each get their own notice, and re-registering a tool with
 * a *differently* broken schema warns again; only the same problem on the same tool of the same
 * session stays quiet. The session's `selector` is the key rather than the namespaced `mcpName` so
 * the single↔multi session flip, which rewrites every `mcpName`, does not re-warn about tools
 * nothing changed about.
 */
export const createMcpToolMapper = (warn: (message: string) => void = defaultWarn): McpToolMapper => {
  const warned = new Set<string>();

  const warnOnce = (tool: NamespacedTool, slot: SchemaSlot, schema: ToolSchemaDescriptor, message: string): void => {
    const key = `${tool.selector}\u0000${tool.descriptor.name}\u0000${slot}\u0000${JSON.stringify(schema)}`;

    if (warned.has(key)) {
      return;
    }

    warned.add(key);
    warn(message);
  };

  const mapInputSchema = (tool: NamespacedTool): Record<string, unknown> => {
    const schema = tool.descriptor.input_schema;

    if (schema === undefined) {
      return EMPTY_OBJECT_SCHEMA;
    }

    const rejection = mcpSchemaRejection(schema, "input");

    if (rejection === undefined) {
      return schema;
    }

    warnOnce(
      tool,
      "input",
      schema,
      `Tool "${tool.mcpName}" declares an input schema MCP cannot accept (${rejection}); MCP tool ` +
        "arguments are always an object, so the schema was replaced with a permissive empty object " +
        "schema and agents cannot see the tool's real arguments. Wrap the input in an object schema.",
    );

    return EMPTY_OBJECT_SCHEMA;
  };

  const mapOutputSchema = (tool: NamespacedTool): Record<string, unknown> | undefined => {
    const schema = tool.descriptor.output_schema;

    if (schema === undefined) {
      return undefined;
    }

    const rejection = mcpSchemaRejection(schema, "output");

    if (rejection === undefined) {
      return schema;
    }

    warnOnce(
      tool,
      "output",
      schema,
      `Tool "${tool.mcpName}" declares an output schema MCP cannot accept (${rejection}); it was ` +
        "dropped from tools/list, so agents get the result without a schema to validate it against. " +
        "Wrap the output in an object schema to give agents a described, structured result.",
    );

    return undefined;
  };

  return (tool, clientHonorsRequiresUserInteraction) => {
    const { descriptor } = tool;
    const requiresUserInteraction = tool.policy === "prompt" && clientHonorsRequiresUserInteraction;
    const outputSchema = mapOutputSchema(tool);

    return {
      name: tool.mcpName,
      description: descriptor.description,
      inputSchema: mapInputSchema(tool),
      ...(outputSchema ? { outputSchema } : {}),
      ...(descriptor.annotations ? { annotations: { ...descriptor.annotations } } : {}),
      // Must be the JSON boolean `true` literal — any other value is ignored by the client.
      ...(requiresUserInteraction ? { _meta: { "anthropic/requiresUserInteraction": true } } : {}),
    };
  };
};
