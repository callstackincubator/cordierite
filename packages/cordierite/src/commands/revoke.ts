/** `cordierite revoke` (ARCHITECTURE.md §10): revokes a session, optionally by selector. */

import { RPC_METHODS } from "@cordierite/shared";

import type { CliResult, RevokeCommandData } from "../cli/result-types.js";
import { callDaemon, type SpawnFn } from "../rpc/client.js";

export type RevokeCommandOptions = {
  selector?: string;
};

export type RevokeCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
};

export const handleRevokeCommand = async (
  options: RevokeCommandOptions,
  context: RevokeCommandContext,
): Promise<CliResult<RevokeCommandData>> => {
  await callDaemon(
    RPC_METHODS.sessionsRevoke,
    { selector: options.selector },
    { stateDir: context.stateDir, spawn: context.spawn },
  );

  return { ok: true, data: { ok: true } };
};
