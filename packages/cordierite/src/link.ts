/**
 * Shared core of `link.create` + deep-link composition + optional emulator/simulator delivery
 * (ARCHITECTURE.md §8, §10): mints a pending session via `link.create`, then composes
 * `<scheme>:///?cordierite=<payload>&pin=<spki-pin>` and optionally delivers it to a booted
 * Android emulator/device or iOS simulator. Used by `commands/link.ts` (`cordierite link`) and
 * `client/bootstrap.ts` (`cordierite/client`'s `link()`) so this shape — scheme resolution, the
 * `pin` query param, the `127.0.0.1` emulator/simulator address override (which the experimental
 * `ios-device` target deliberately opts out of) — can't drift between the CLI and the programmatic
 * client.
 *
 * The `pin` param is separate from the `cordierite` bootstrap blob (opt-in hardening dev-mode) — it
 * is never part of that binary v2 payload, so old apps that don't know about it simply ignore it.
 * It carries the daemon's SPKI pin (same value as `daemon.status`'s `pinnedKeys[0]` / `cordierite
 * keygen`'s output) so a debug build with no build-time `cliPins` configured can trust it for this
 * one connection instead of requiring a native rebuild just to test locally. The pin is standard
 * (non-URL-safe) base64 (`sha256/<44-char-base64>`, may contain `+`/`/`/`=`), so it is percent-
 * encoded here; native/JS parsers use `URLSearchParams`, which decodes it back.
 */
import { RPC_METHODS, type AgentEndpoint, type LinkCreateResult } from "@cordierite/shared";

import {
  deliverToOpenTarget,
  isOpenTarget,
  isValidBundleId,
  invalidBundleIdMessage,
  usesLoopbackAddress,
  MISSING_BUNDLE_ID_MESSAGE,
  OPEN_TARGETS,
  type ExecFn,
  type OpenTarget,
} from "./cli/open-target.js";
import { loadConfig } from "./daemon/config.js";
import { getStateDirPaths } from "./daemon/state-dir.js";
import { usageError } from "./errors.js";
import { callDaemon, type SpawnFn } from "./rpc/client.js";

/** The emulator/simulator fast path forces `127.0.0.1`: the daemon's wss listener already binds
 * all interfaces, and both delivery mechanisms (adb reverse, the iOS simulator's shared host
 * network) make the daemon reachable there regardless of the machine's real LAN address. A
 * physical iOS device (`ios-device`) has no such tunnel, so it keeps the detected LAN address —
 * see `usesLoopbackAddress`. */
const OPEN_TARGET_ADDRESS_OVERRIDE = "127.0.0.1";

export type MintLinkOptions = {
  stateDir: string;
  spawn?: SpawnFn;
  autoSpawn?: boolean;
  ttlSeconds?: number;
  /** Delivers the link directly to a booted Android emulator/device or iOS simulator instead of
   * leaving delivery to the caller. */
  target?: OpenTarget;
  /** An adb device serial (`target: "android"`), a simulator udid (`target: "ios-sim"`) or a
   * paired-device udid (`target: "ios-device"`). Only meaningful alongside a target. */
  device?: string;
  /** Overrides `config.json`'s `iosBundleId`. Only meaningful with `target: "ios-device"`. */
  bundleId?: string;
  /** Overrides `config.json`'s `scheme`. */
  scheme?: string;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
};

export type MintLinkResult = {
  sessionId: string;
  deepLink: string;
  endpoint: AgentEndpoint;
  /** Unix seconds. */
  expiresAt: number;
  pin: string;
  delivered?: true;
  target?: OpenTarget;
};

/** Throws `usageError`/`CordieriteCliError` on validation failure — `commands/link.ts` renders
 * that straight through the CLI's own error path; `client/bootstrap.ts` converts it to a
 * `CordieriteError` via `toCordieriteError` (which already understands `CordieriteCliError`). */
export const mintLink = async (options: MintLinkOptions): Promise<MintLinkResult> => {
  if (options.target !== undefined && !isOpenTarget(options.target)) {
    throw usageError(
      `"target" must be one of ${OPEN_TARGETS.map((target) => `"${target}"`).join(", ")} (got "${
        options.target
      }").`,
    );
  }

  if (options.device !== undefined && options.target === undefined) {
    throw usageError('"device" only applies alongside a target.');
  }

  if (options.bundleId !== undefined && options.target !== "ios-device") {
    throw usageError('"bundleId" only applies alongside target "ios-device".');
  }

  const paths = getStateDirPaths(options.stateDir);
  const config = await loadConfig(paths);
  const scheme = options.scheme ?? config.scheme;

  if (!scheme) {
    throw usageError(
      'A deep-link scheme is required: pass a "scheme" option (`--scheme` on the CLI), or set "scheme" in config.json.',
    );
  }

  // `ios-device` needs a bundle id `devicectl` can launch; resolved (and required) *before* the
  // link is minted so a missing one is a plain usage error rather than a stranded pending session.
  const bundleId = options.target === "ios-device" ? (options.bundleId ?? config.iosBundleId) : undefined;

  if (options.target === "ios-device" && !bundleId) {
    throw usageError(MISSING_BUNDLE_ID_MESSAGE);
  }

  if (bundleId !== undefined && !isValidBundleId(bundleId)) {
    throw usageError(invalidBundleIdMessage(bundleId));
  }

  const result = await callDaemon<LinkCreateResult>(
    RPC_METHODS.linkCreate,
    {
      ttlSeconds: options.ttlSeconds,
      addressOverride:
        options.target && usesLoopbackAddress(options.target) ? OPEN_TARGET_ADDRESS_OVERRIDE : undefined,
    },
    { stateDir: options.stateDir, spawn: options.spawn, autoSpawn: options.autoSpawn },
  );

  const deepLink = `${scheme}:///?cordierite=${result.deepLinkPayload}&pin=${encodeURIComponent(result.pin)}`;

  if (options.target) {
    await deliverToOpenTarget({
      target: options.target,
      deepLink,
      wssPort: result.endpoint.port,
      device: options.device,
      bundleId,
      exec: options.exec,
      env: options.env,
    });

    return {
      sessionId: result.sessionId,
      deepLink,
      endpoint: result.endpoint,
      expiresAt: result.expiresAt,
      pin: result.pin,
      delivered: true,
      target: options.target,
    };
  }

  return {
    sessionId: result.sessionId,
    deepLink,
    endpoint: result.endpoint,
    expiresAt: result.expiresAt,
    pin: result.pin,
  };
};
