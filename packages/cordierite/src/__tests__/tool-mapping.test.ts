/**
 * Pure unit test for `mcp/tool-mapping.ts`'s `toMcpTool` — specifically the
 * `emitRequiresUserInteractionFlag` gate (ARCHITECTURE.md §12 / issues #10 & #14). `mcp/server.ts`
 * folds the elicitation-channel preference into that single boolean before calling this function
 * (never emit the flag once elicitation is preferred, so a "prompt" tool can't arm both consent
 * channels for one call) — this test exercises the mapper's side of that contract directly, without
 * standing up a daemon or an MCP client.
 */

import { describe, expect, test } from "vitest";

import type { ToolDescriptor } from "@cordierite/shared";

import { toMcpTool } from "../mcp/tool-mapping.js";
import type { NamespacedTool } from "../mcp/tool-namespace.js";

const descriptor: ToolDescriptor = { name: "deleteAll", description: "Deletes everything." };

const namespacedTool = (policy: NamespacedTool["policy"]): NamespacedTool => ({
  mcpName: "deleteAll",
  selector: "pixel-8",
  descriptor,
  policy,
});

describe("toMcpTool: requiresUserInteraction flag", () => {
  test('a "prompt" tool gets the flag when the caller says to emit it', () => {
    const mapped = toMcpTool(namespacedTool("prompt"), true);
    expect(mapped._meta).toEqual({ "anthropic/requiresUserInteraction": true });
  });

  test('a "prompt" tool gets no flag when the caller says not to — e.g. elicitation was preferred for this connection (issue #10)', () => {
    const mapped = toMcpTool(namespacedTool("prompt"), false);
    expect(mapped._meta).toBeUndefined();
  });

  test('an "allow" tool never gets the flag, even when the caller would otherwise emit it', () => {
    const mapped = toMcpTool(namespacedTool("allow"), true);
    expect(mapped._meta).toBeUndefined();
  });

  test('a "deny" tool never gets the flag either', () => {
    const mapped = toMcpTool(namespacedTool("deny"), true);
    expect(mapped._meta).toBeUndefined();
  });
});
