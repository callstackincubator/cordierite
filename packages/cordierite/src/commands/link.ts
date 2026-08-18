/**
 * `cordierite link` (ARCHITECTURE.md §10, §8): CLI-flag validation (`--open`/`--device`'s
 * CLI-specific error wording) around the shared `mintLink` core (`../link.ts`), which both this
 * command and `cordierite/client`'s `link()` use so the deep-link shape can't drift between them.
 */

import type { CliResult, LinkCommandData } from "../cli/result-types.js";
import { isOpenTarget, type ExecFn, type OpenTarget } from "../cli/open-target.js";
import { mintLink } from "../link.js";
import { usageError } from "../errors.js";
import type { SpawnFn } from "../rpc/client.js";

export type LinkCommandOptions = {
  ttlSeconds?: number;
  scheme?: string;
  open?: string;
  device?: string;
};

export type LinkCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
};

export const handleLinkCommand = async (
  options: LinkCommandOptions,
  context: LinkCommandContext,
): Promise<CliResult<LinkCommandData>> => {
  let openTarget: OpenTarget | undefined;

  if (options.open !== undefined) {
    if (!isOpenTarget(options.open)) {
      throw usageError(`"--open" must be "android" or "ios-sim" (got "${options.open}").`);
    }

    openTarget = options.open;
  }

  if (options.device !== undefined && openTarget !== "android") {
    throw usageError('"--device" only applies with "--open android".');
  }

  const result = await mintLink({
    stateDir: context.stateDir,
    spawn: context.spawn,
    ttlSeconds: options.ttlSeconds,
    scheme: options.scheme,
    target: openTarget,
    device: options.device,
    exec: context.exec,
    env: context.env,
  });

  return { ok: true, data: result };
};
