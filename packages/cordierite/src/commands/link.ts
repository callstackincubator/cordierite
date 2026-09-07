/**
 * `cordierite link` (ARCHITECTURE.md §10, §8): CLI-flag validation (`--open`/`--device`'s
 * CLI-specific error wording) around the shared `mintLink` core (`../link.ts`), which both this
 * command and `cordierite/client`'s `link()` use so the deep-link shape can't drift between them.
 */

import type { CliResult, LinkCommandData } from "../cli/result-types.js";
import { isOpenTarget, OPEN_TARGETS, type ExecFn, type OpenTarget } from "../cli/open-target.js";
import { mintLink } from "../link.js";
import { usageError } from "../errors.js";
import type { SpawnFn } from "../rpc/client.js";

export type LinkCommandOptions = {
  ttlSeconds?: number;
  scheme?: string;
  open?: string;
  device?: string;
  bundleId?: string;
  relaunch?: boolean;
};

export type LinkCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
  /** Where scheme discovery starts (project config walk-up, then `app.json`); defaults to
   * `process.cwd()`, which for this command is the app root the developer is standing in. */
  cwd?: string;
  exec?: ExecFn;
  /** Environment for `adb`/`simctl`, not for `CORDIERITE_SCHEME` (see `schemeEnv`). */
  env?: NodeJS.ProcessEnv;
  /** The environment `CORDIERITE_SCHEME` is read from; defaults to `process.env`. */
  schemeEnv?: NodeJS.ProcessEnv;
};

export const handleLinkCommand = async (
  options: LinkCommandOptions,
  context: LinkCommandContext,
): Promise<CliResult<LinkCommandData>> => {
  let openTarget: OpenTarget | undefined;

  if (options.open !== undefined) {
    if (!isOpenTarget(options.open)) {
      throw usageError(
        `"--open" must be one of ${OPEN_TARGETS.map((target) => `"${target}"`).join(", ")} (got "${
          options.open
        }").`,
      );
    }

    openTarget = options.open;
  }

  if (options.device !== undefined && openTarget === undefined) {
    throw usageError('"--device" only applies with "--open".');
  }

  // A bundle id is only ever consumed by the `devicectl` launch; accepting it silently elsewhere
  // would let `--open ios-sim --bundle-id ...` look like it did something it did not.
  if (options.bundleId !== undefined && openTarget !== "ios-device") {
    throw usageError('"--bundle-id" only applies with "--open ios-device".');
  }

  if (options.relaunch !== undefined && openTarget !== "ios-device") {
    throw usageError('"--relaunch" only applies with "--open ios-device".');
  }

  const result = await mintLink({
    stateDir: context.stateDir,
    spawn: context.spawn,
    ttlSeconds: options.ttlSeconds,
    scheme: options.scheme,
    cwd: context.cwd,
    target: openTarget,
    device: options.device,
    bundleId: options.bundleId,
    relaunch: options.relaunch,
    exec: context.exec,
    env: context.env,
    schemeEnv: context.schemeEnv,
  });

  return { ok: true, data: result };
};
