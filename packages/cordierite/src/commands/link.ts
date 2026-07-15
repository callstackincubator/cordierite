/**
 * `cordierite link` (ARCHITECTURE.md §10, §8): mints a pending session via `link.create`, then
 * composes the deep link `<scheme>:///?cordierite=<payload>`. The scheme comes from `--scheme`,
 * else `config.json`'s `scheme` field, else the command errors with a clear message.
 */

import { RPC_METHODS, type LinkCreateResult } from "@cordierite/shared";

import type { CliResult, LinkCommandData } from "../cli/result-types.js";
import { loadConfig } from "../daemon/config.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import { usageError } from "../errors.js";
import { callDaemon, type SpawnFn } from "../rpc/client.js";

export type LinkCommandOptions = {
  ttlSeconds?: number;
  scheme?: string;
};

export type LinkCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
};

export const handleLinkCommand = async (
  options: LinkCommandOptions,
  context: LinkCommandContext,
): Promise<CliResult<LinkCommandData>> => {
  const paths = getStateDirPaths(context.stateDir);
  const config = await loadConfig(paths);
  const scheme = options.scheme ?? config.scheme;

  if (!scheme) {
    throw usageError(
      'A deep-link scheme is required: pass --scheme, or set "scheme" in config.json.',
    );
  }

  const result = await callDaemon<LinkCreateResult>(
    RPC_METHODS.linkCreate,
    { ttlSeconds: options.ttlSeconds },
    { stateDir: context.stateDir, spawn: context.spawn },
  );

  return {
    ok: true,
    data: {
      sessionId: result.sessionId,
      deepLink: `${scheme}:///?cordierite=${result.deepLinkPayload}`,
      endpoint: result.endpoint,
      expiresAt: result.expiresAt,
    },
  };
};
