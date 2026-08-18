/**
 * Maps a `NamespacedTool` (daemon `ToolDescriptor` + resolved external name) onto the MCP SDK's
 * `Tool` wire shape (ARCHITECTURE.md §9/§7): `description` and `input_schema`/`output_schema` map
 * directly; an absent `input_schema` becomes an empty, permissive object schema (MCP requires every
 * tool's `inputSchema.type` to be the literal `"object"`); `annotations` map verbatim.
 *
 * A tool whose effective policy is `"prompt"` (ARCHITECTURE.md §12) gets
 * `_meta["anthropic/requiresUserInteraction"] = true` — but only when the connected client is
 * known to enforce it (issue #14); emitting the flag for a client that ignores it would create a
 * false sense of security, so the caller must confirm that separately and pass it in.
 */

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

export const toMcpTool = (tool: NamespacedTool, clientHonorsRequiresUserInteraction: boolean): McpToolSchema => {
  const { descriptor } = tool;
  const requiresUserInteraction = tool.policy === "prompt" && clientHonorsRequiresUserInteraction;

  return {
    name: tool.mcpName,
    description: descriptor.description,
    inputSchema: descriptor.input_schema ?? EMPTY_OBJECT_SCHEMA,
    ...(descriptor.output_schema ? { outputSchema: descriptor.output_schema } : {}),
    ...(descriptor.annotations ? { annotations: { ...descriptor.annotations } } : {}),
    // Must be the JSON boolean `true` literal — any other value is ignored by the client.
    ...(requiresUserInteraction ? { _meta: { "anthropic/requiresUserInteraction": true } } : {}),
  };
};
