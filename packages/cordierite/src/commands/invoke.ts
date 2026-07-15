/**
 * `cordierite invoke` (ARCHITECTURE.md §10): `tools.call` round trip. Failures propagate as-is
 * (`DaemonRpcError`, preserving `error.data.type` verbatim) — `errors.ts`'s `toCliError` is what
 * renders `error.type` as the app's wire error type end-to-end, not this module's job.
 */

import { RPC_METHODS, type ToolsCallResult } from "@cordierite/shared";

import type { CliResult, InvokeCommandData } from "../cli/result-types.js";
import { callDaemon, type SpawnFn } from "../rpc/client.js";

export type InvokeCommandOptions = {
  selector?: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
};

export type InvokeCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
};

export const handleInvokeCommand = async (
  options: InvokeCommandOptions,
  context: InvokeCommandContext,
): Promise<CliResult<InvokeCommandData>> => {
  const result = await callDaemon<ToolsCallResult>(
    RPC_METHODS.toolsCall,
    {
      selector: options.selector,
      name: options.tool,
      args: options.args,
      timeoutMs: options.timeoutMs,
    },
    { stateDir: context.stateDir, spawn: context.spawn },
  );

  return { ok: true, data: result.result };
};
