/**
 * Maps a `NamespacedTool` (daemon `ToolDescriptor` + resolved external name) onto the MCP SDK's
 * `Tool` wire shape (ARCHITECTURE.md §9/§7): `description` maps directly and `annotations` map
 * verbatim, while `input_schema`/`output_schema` are gated on being rooted at the literal
 * `type: "object"` that MCP requires (see `isObjectRootedSchema`) — an absent or non-object-rooted
 * `input_schema` becomes an empty, permissive object schema, and a non-object-rooted
 * `output_schema` is dropped entirely (issue #26). Either way the tool stays listed and callable:
 * one app-side schema MCP cannot represent must never take down the whole `tools/list`.
 *
 * A tool whose effective policy is `"prompt"` (ARCHITECTURE.md §12) gets
 * `_meta["anthropic/requiresUserInteraction"] = true` — but only when the connected client is
 * known to enforce it (issue #14); emitting the flag for a client that ignores it would create a
 * false sense of security, so the caller must confirm that separately and pass it in.
 */

import { isObjectRootedSchema } from "@cordierite/shared";

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

/** Dedupes the stderr notices below: `tools/list` is re-answered on every client request and on
 * every `notifications/tools/list_changed` refresh, so an un-deduped warning would repeat forever.
 * Keyed by the tool's own name so the notice is not re-emitted when the single↔multi session flip
 * changes its namespaced `mcpName`. */
const droppedOutputSchemaWarned = new Set<string>();
const replacedInputSchemaWarned = new Set<string>();

/** stderr only — stdout carries the MCP transport's protocol frames (ARCHITECTURE.md §9). */
const warnOnce = (seen: Set<string>, toolName: string, message: string): void => {
  if (seen.has(toolName)) {
    return;
  }
  seen.add(toolName);
  console.error(`[cordierite] ${message}`);
};

/** Test-only: the dedup sets are module state that would otherwise leak between cases. */
export const resetToolMappingWarnings = (): void => {
  droppedOutputSchemaWarned.clear();
  replacedInputSchemaWarned.clear();
};

const mapInputSchema = (toolName: string, schema: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (schema === undefined) {
    return EMPTY_OBJECT_SCHEMA;
  }

  if (isObjectRootedSchema(schema)) {
    return schema;
  }

  warnOnce(
    replacedInputSchemaWarned,
    toolName,
    `Tool "${toolName}" declares an input schema that is not rooted at type "object" ` +
      `(got ${JSON.stringify(schema.type ?? null)}); MCP tool arguments are always an object, so the ` +
      "schema was replaced with a permissive empty object schema. Wrap the input in an object schema.",
  );

  return EMPTY_OBJECT_SCHEMA;
};

const mapOutputSchema = (
  toolName: string,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (schema === undefined || isObjectRootedSchema(schema)) {
    return schema;
  }

  warnOnce(
    droppedOutputSchemaWarned,
    toolName,
    `Tool "${toolName}" declares an output schema that is not rooted at type "object" ` +
      `(got ${JSON.stringify(schema.type ?? null)}); MCP only accepts object-rooted output schemas, ` +
      "so it was dropped from tools/list and results are returned as text content only. Wrap the " +
      "output in an object schema to give agents structured content.",
  );

  return undefined;
};

export const toMcpTool = (tool: NamespacedTool, clientHonorsRequiresUserInteraction: boolean): McpToolSchema => {
  const { descriptor } = tool;
  const requiresUserInteraction = tool.policy === "prompt" && clientHonorsRequiresUserInteraction;
  const outputSchema = mapOutputSchema(descriptor.name, descriptor.output_schema);

  return {
    name: tool.mcpName,
    description: descriptor.description,
    inputSchema: mapInputSchema(descriptor.name, descriptor.input_schema),
    ...(outputSchema ? { outputSchema } : {}),
    ...(descriptor.annotations ? { annotations: { ...descriptor.annotations } } : {}),
    // Must be the JSON boolean `true` literal — any other value is ignored by the client.
    ...(requiresUserInteraction ? { _meta: { "anthropic/requiresUserInteraction": true } } : {}),
  };
};
