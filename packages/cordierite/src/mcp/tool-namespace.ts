/**
 * Builds the effective MCP tool list from live daemon sessions and their tool registries
 * (ARCHITECTURE.md §9): exactly one live session exposes tools under their
 * own names; two or more namespace every tool as `<alias>__<name>` so names never collide across
 * devices.
 *
 * The `__` separator is unambiguous to split back apart even though a tool's own name
 * (`[a-zA-Z0-9_-]{1,64}`, `daemon/registry.ts`) may itself contain underscores: aliases
 * (`daemon/sessions.ts`'s `slugifyDeviceModel`/`dedupeAlias`) only ever contain lowercase
 * alphanumerics and hyphens, so the alias half of a namespaced name never itself contains `__` —
 * the first occurrence of `__` in a namespaced name is always the alias/tool-name boundary.
 */

import type { EffectivePolicyDecision, SessionSummary, ToolDescriptor, ToolsListEntry } from "@cordierite/shared";

export const TOOL_NAMESPACE_SEPARATOR = "__";

export type NamespacedTool = {
  /** The name exposed to MCP clients: `descriptor.name` verbatim when exactly one session is live,
   * else `<alias>__<name>`. */
  mcpName: string;
  /** The session alias `tools.call`'s `selector` should target for this tool. */
  selector: string;
  descriptor: ToolDescriptor;
  /** The effective policy decision for this tool right now (ARCHITECTURE.md §12), as resolved by
   * the daemon's `tools.list` — carried through so the MCP server can emit
   * `_meta["anthropic/requiresUserInteraction"]` and set `consent` on `tools.call` without a
   * second round trip (issue #14). */
  policy: EffectivePolicyDecision;
};

/** Builds the namespaced (or not) tool list for the current set of live sessions. `toolsByAlias`
 * is looked up by `session.alias` (not `sessionId`) to match `tools.list`'s `selector` semantics. */
export const buildNamespacedTools = (
  sessions: readonly SessionSummary[],
  toolsByAlias: ReadonlyMap<string, readonly ToolsListEntry[]>,
): NamespacedTool[] => {
  const namespaced = sessions.length > 1;
  const tools: NamespacedTool[] = [];

  for (const session of sessions) {
    for (const entry of toolsByAlias.get(session.alias) ?? []) {
      // Explicit pick (not a `{ policy, ...descriptor }` rest-spread) so a future non-descriptor
      // field added to `ToolsListEntry` can't silently leak into `descriptor` and from there into
      // the MCP tool surface and the snapshot key below.
      const descriptor: ToolDescriptor = {
        name: entry.name,
        description: entry.description,
        input_schema: entry.input_schema,
        output_schema: entry.output_schema,
        annotations: entry.annotations,
        timeoutMs: entry.timeoutMs,
      };

      tools.push({
        mcpName: namespaced ? `${session.alias}${TOOL_NAMESPACE_SEPARATOR}${descriptor.name}` : descriptor.name,
        selector: session.alias,
        descriptor,
        policy: entry.policy,
      });
    }
  }

  return tools;
};

export const findNamespacedTool = (
  tools: readonly NamespacedTool[],
  mcpName: string,
): NamespacedTool | undefined => {
  return tools.find((tool) => tool.mcpName === mcpName);
};

/** A stable, order-independent key used to detect whether the effective tool list actually
 * changed (name, target session, and full descriptor) — used to decide whether to fire
 * `notifications/tools/list_changed` rather than on every qualifying daemon event. */
export const namespacedToolsSnapshotKey = (tools: readonly NamespacedTool[]): string => {
  const sorted = tools
    .map((tool) => ({ name: tool.mcpName, selector: tool.selector, descriptor: tool.descriptor, policy: tool.policy }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify(sorted);
};
