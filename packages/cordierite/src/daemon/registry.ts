/**
 * Per-session tool registry (ARCHITECTURE.md §7). Callers (sessions.ts/listener.ts) must validate
 * incoming `tool_registry_snapshot`/`tool_registry_delta` wire messages with the shared guards
 * *before* calling into this module — v1 crashed by indexing into an unvalidated `tools: [null]`
 * snapshot; this module only ever stores already-validated {@link ToolDescriptor}s.
 */

import type { ToolDescriptor } from "@cordierite/shared";

export type ToolRegistry = {
  /** Authoritative replace: used for the initial snapshot and every post-resume re-sync. */
  snapshot: (tools: ToolDescriptor[]) => void;
  upsert: (tool: ToolDescriptor) => void;
  remove: (name: string) => void;
  list: () => ToolDescriptor[];
  get: (name: string) => ToolDescriptor | undefined;
  count: () => number;
};

/** `onChange` fires after every mutation (snapshot/upsert/remove) — used to emit `tools_changed`. */
export const createToolRegistry = (onChange?: () => void): ToolRegistry => {
  let tools = new Map<string, ToolDescriptor>();

  const notify = (): void => {
    onChange?.();
  };

  return {
    snapshot: (incoming) => {
      tools = new Map(incoming.map((tool) => [tool.name, tool] as const));
      notify();
    },
    upsert: (tool) => {
      tools.set(tool.name, tool);
      notify();
    },
    remove: (name) => {
      if (tools.delete(name)) {
        notify();
      }
    },
    list: () => Array.from(tools.values()),
    get: (name) => tools.get(name),
    count: () => tools.size,
  };
};
