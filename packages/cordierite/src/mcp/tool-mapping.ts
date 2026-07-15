/**
 * Maps a `NamespacedTool` (daemon `ToolDescriptor` + resolved external name) onto the MCP SDK's
 * `Tool` wire shape (ARCHITECTURE.md §9/§7): `description` and `input_schema`/`output_schema` map
 * directly; an absent `input_schema` becomes an empty, permissive object schema (MCP requires every
 * tool's `inputSchema.type` to be the literal `"object"`); `annotations` map verbatim.
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
};

export const toMcpTool = (tool: NamespacedTool): McpToolSchema => {
  const { descriptor } = tool;

  return {
    name: tool.mcpName,
    description: descriptor.description,
    inputSchema: descriptor.input_schema ?? EMPTY_OBJECT_SCHEMA,
    ...(descriptor.output_schema ? { outputSchema: descriptor.output_schema } : {}),
    ...(descriptor.annotations ? { annotations: { ...descriptor.annotations } } : {}),
  };
};
