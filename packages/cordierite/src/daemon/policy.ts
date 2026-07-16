/**
 * Tool-call policy evaluation (ARCHITECTURE.md §12). Every `tools.call` — CLI and MCP alike —
 * passes through {@link evaluate} before the daemon sends anything to the app. Precedence:
 *
 * 1. a per-tool override, `policy.tools["<alias>/<name>"]`, wins outright;
 * 2. else `policy.destructive` applies to tools whose descriptor sets
 *    `annotations.destructiveHint === true`;
 * 3. else `policy.default`.
 *
 * This module is pure and synchronous — it knows nothing about sockets, audit, or the RPC layer;
 * the daemon composition root (`daemon.ts`) is the single seam that calls it and reacts to the
 * decision (deny → `policy_denied`, no frame to the app, per ARCHITECTURE.md §5/§12).
 */

import type { ToolDescriptor } from "@cordierite/shared";

import type { CordieritePolicyConfig, PolicyDecision } from "./config.js";

/** The pieces of a resolved session {@link evaluate} needs to key a per-tool override. */
export type PolicySession = {
  alias: string;
};

export const policyOverrideKey = (alias: string, toolName: string): string => `${alias}/${toolName}`;

export const evaluate = (
  descriptor: ToolDescriptor,
  session: PolicySession,
  policy: CordieritePolicyConfig,
): PolicyDecision => {
  const override = policy.tools?.[policyOverrideKey(session.alias, descriptor.name)];

  if (override !== undefined) {
    return override;
  }

  if (descriptor.annotations?.destructiveHint === true) {
    return policy.destructive;
  }

  return policy.default;
};
