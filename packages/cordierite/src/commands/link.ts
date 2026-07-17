/**
 * `cordierite link` (ARCHITECTURE.md §10, §8): mints a pending session via `link.create`, then
 * composes the deep link `<scheme>:///?cordierite=<payload>&pin=<spki-pin>`. The scheme comes
 * from `--scheme`, else `config.json`'s `scheme` field, else the command errors with a clear
 * message.
 *
 * The `pin` param (opt-in hardening dev-mode) is separate from the `cordierite` bootstrap blob —
 * it is never part of that binary v2 payload, so old apps that don't know about it simply ignore
 * it. It carries the daemon's SPKI pin (same value as `daemon.status`'s `pinnedKeys[0]` /
 * `cordierite keygen`'s output) so a debug build with no build-time `cliPins` configured can trust
 * it for this one connection instead of requiring a native rebuild just to test locally. The pin
 * is standard (non-URL-safe) base64 (`sha256/<44-char-base64>`, may contain `+`/`/`/`=`), so it is
 * percent-encoded here; native/JS parsers use `URLSearchParams`, which decodes it back.
 *
 * `--open android|ios-sim` (task 07) additionally forces the advertised address to `127.0.0.1`
 * (the simulator/emulator reaches the daemon over localhost — the wss listener already binds all
 * interfaces) and delivers the link via adb/xcrun instead of just printing it.
 */

import { RPC_METHODS, type LinkCreateResult } from "@cordierite/shared";

import type { CliResult, LinkCommandData } from "../cli/result-types.js";
import { loadConfig } from "../daemon/config.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import { usageError } from "../errors.js";
import { callDaemon, type SpawnFn } from "../rpc/client.js";
import { deliverToOpenTarget, isOpenTarget, type ExecFn, type OpenTarget } from "../cli/open-target.js";

/** The emulator/simulator fast path forces `127.0.0.1`: the daemon's wss listener already binds
 * all interfaces, and both delivery mechanisms (adb reverse, the iOS simulator's shared host
 * network) make the daemon reachable there regardless of the machine's real LAN address. */
const OPEN_TARGET_ADDRESS_OVERRIDE = "127.0.0.1";

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
    {
      ttlSeconds: options.ttlSeconds,
      addressOverride: openTarget ? OPEN_TARGET_ADDRESS_OVERRIDE : undefined,
    },
    { stateDir: context.stateDir, spawn: context.spawn },
  );

  const deepLink = `${scheme}:///?cordierite=${result.deepLinkPayload}&pin=${encodeURIComponent(result.pin)}`;

  if (openTarget) {
    await deliverToOpenTarget({
      target: openTarget,
      deepLink,
      wssPort: result.endpoint.port,
      device: options.device,
      exec: context.exec,
      env: context.env,
    });
  }

  return {
    ok: true,
    data: {
      sessionId: result.sessionId,
      deepLink,
      endpoint: result.endpoint,
      expiresAt: result.expiresAt,
      pin: result.pin,
      ...(openTarget ? { delivered: true as const, target: openTarget } : {}),
    },
  };
};
