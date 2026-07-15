/**
 * Fetches the effective (possibly namespaced) MCP tool list live from the daemon
 * (ARCHITECTURE.md §9): `sessions.list` for the live sessions, then `tools.list` per session.
 * There is no caching here — every `tools/list` request and every list-changed check re-fetches,
 * since the daemon's session/registry state is the single source of truth and can change between
 * any two calls.
 */

import {
  RPC_METHODS,
  type SessionsListResult,
  type ToolDescriptor,
  type ToolsListResult,
} from "@cordierite/shared";

import { DaemonRpcError } from "../rpc/client.js";
import { buildNamespacedTools, type NamespacedTool } from "./tool-namespace.js";

/** A method call against the daemon RPC — satisfied by both `callDaemon` (bound to a method+params)
 * and `DaemonStream.call` from `rpc/client.ts`. */
export type DaemonCall = <TResult>(method: string, params?: unknown) => Promise<TResult>;

export const fetchEffectiveTools = async (call: DaemonCall): Promise<NamespacedTool[]> => {
  const sessions = await call<SessionsListResult>(RPC_METHODS.sessionsList);
  const toolsByAlias = new Map<string, ToolDescriptor[]>();

  for (const session of sessions) {
    try {
      toolsByAlias.set(
        session.alias,
        await call<ToolsListResult>(RPC_METHODS.toolsList, { selector: session.alias }),
      );
    } catch (error) {
      // The session can transition (revoke/expire) between `sessions.list` and this per-session
      // `tools.list` call; treat it as having no tools rather than failing the whole listing.
      if (error instanceof DaemonRpcError) {
        toolsByAlias.set(session.alias, []);
        continue;
      }

      throw error;
    }
  }

  return buildNamespacedTools(sessions, toolsByAlias);
};
