/** `cordierite ls` (ARCHITECTURE.md §10): `sessions.list` passthrough. */

import { RPC_METHODS, type SessionsListResult } from "@cordierite/shared";

import type { CliResult, LsCommandData } from "../cli/result-types.js";
import { callDaemon, type SpawnFn } from "../rpc/client.js";

export type LsCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
};

export const handleLsCommand = async (context: LsCommandContext): Promise<CliResult<LsCommandData>> => {
  const sessions = await callDaemon<SessionsListResult>(
    RPC_METHODS.sessionsList,
    {},
    { stateDir: context.stateDir, spawn: context.spawn },
  );

  return { ok: true, data: sessions };
};
