/**
 * `link()`/`waitForSession()` (issue #8): the bootstrap half of the client, so a test's
 * `globalSetup` can pair a simulator/emulator without shelling out to `cordierite link --open`.
 * `link()` delegates to the same `mintLink` core `commands/link.ts` uses (`../link.js`) so the
 * deep-link shape can't drift between the CLI and this package; `waitForSession()` mirrors
 * `mcp/connect-tool.ts`'s `handleWaitForSessionTool`.
 */
import { RPC_METHODS, type EventNotification, type SessionsDescribeResult } from "@cordierite/shared";

import { type ExecFn, type OpenTarget } from "../cli/open-target.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import { mintLink, type MintLinkResult } from "../link.js";
import { openDaemonStream, DaemonRpcError, type DaemonStream, type SpawnFn } from "../rpc/client.js";
import { makeAppClient, type AppClient, type ToolMap } from "./app-client.js";
import { CordieriteError, toCordieriteError } from "./errors.js";

const DEFAULT_WAIT_FOR_SESSION_TIMEOUT_MS = 120_000;

export type LinkOptions = {
  stateDir?: string;
  spawn?: SpawnFn;
  /** Auto-spawn a daemon on a missing connection. Defaults to `true`. */
  autoSpawn?: boolean;
  ttlSeconds?: number;
  /** Delivers the link directly to a booted Android emulator/device or iOS simulator instead of
   * just minting it (the CI/agent path — no human needed to scan a QR). */
  target?: OpenTarget;
  /** `--device` equivalent; only valid with `target: "android"`. */
  device?: string;
  /** Highest-precedence scheme source, ahead of `CORDIERITE_SCHEME`, a project
   * `.cordierite/config.json`, the state dir's `config.json` and `app.json` (see `scheme.ts`). */
  scheme?: string;
  /** Where scheme discovery starts; defaults to `process.cwd()`. */
  cwd?: string;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
};

export type LinkResult = MintLinkResult;

/** Mints a session link via `link.create` and composes the deep link. With `target` set, delivers
 * it directly to a booted emulator/simulator instead of leaving delivery to the caller. */
export const link = async (options: LinkOptions = {}): Promise<LinkResult> => {
  try {
    return await mintLink({
      stateDir: resolveStateDir(options.stateDir),
      spawn: options.spawn,
      autoSpawn: options.autoSpawn,
      ttlSeconds: options.ttlSeconds,
      target: options.target,
      device: options.device,
      scheme: options.scheme,
      cwd: options.cwd,
      exec: options.exec,
      env: options.env,
    });
  } catch (error) {
    throw toCordieriteError(error);
  }
};

export type WaitForSessionOptions = {
  stateDir?: string;
  spawn?: SpawnFn;
  /** Auto-spawn a daemon on a missing connection. Defaults to `true`. */
  autoSpawn?: boolean;
  /** Defaults to 120s. */
  timeoutMs?: number;
};

/** Waits for `sessionId` (from {@link link}) to be claimed by a device, then returns a connected
 * {@link AppClient} for it — resolves immediately if it's already claimed. */
export const waitForSession = async <TTools = ToolMap>(
  sessionId: string,
  options: WaitForSessionOptions = {},
): Promise<AppClient<TTools>> => {
  const stateDir = resolveStateDir(options.stateDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_SESSION_TIMEOUT_MS;

  let stream: DaemonStream;

  try {
    stream = await openDaemonStream({ stateDir, spawn: options.spawn, autoSpawn: options.autoSpawn });
  } catch (error) {
    throw toCordieriteError(error);
  }

  try {
    // The session may already be claimed by the time this runs — resolve immediately rather than
    // waiting for an event that already happened.
    try {
      await stream.call<SessionsDescribeResult>(RPC_METHODS.sessionsDescribe, { selector: sessionId });
      return makeAppClient<TTools>(stream, sessionId);
    } catch (error) {
      if (!(error instanceof DaemonRpcError) || error.data?.type !== "unknown_session") {
        throw error;
      }
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        unsubscribeNotification();
        unsubscribeClose();
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new CordieriteError(
              "timeout",
              `Timed out after ${timeoutMs}ms waiting for session "${sessionId}" to be claimed.`,
            ),
          ),
        );
      }, timeoutMs);

      const unsubscribeClose = stream.onClose(() => {
        settle(() =>
          reject(
            new CordieriteError(
              "connection_error",
              `The connection to the Cordierite daemon closed while waiting for session "${sessionId}" to be claimed.`,
            ),
          ),
        );
      });

      // Registered *before* `events.subscribe` is sent (not after awaiting it) — a
      // `session_claimed` notification that arrives in the same TCP chunk as the subscribe
      // response is dispatched synchronously within that chunk's processing, before an `await`
      // continuation below would get a chance to run; registering the listener first means it's
      // always in place in time to see it.
      const unsubscribeNotification = stream.onNotification((payload) => {
        if (settled) {
          return;
        }

        const event = payload as EventNotification;

        if (event.kind === "session_claimed" && event.sessionId === sessionId) {
          settle(resolve);
        }
      });

      stream
        .call(RPC_METHODS.eventsSubscribe, { sessionSelector: sessionId, kinds: ["session_claimed"] })
        .catch((error) => {
          settle(() => reject(toCordieriteError(error)));
        });
    });

    return makeAppClient<TTools>(stream, sessionId);
  } catch (error) {
    stream.close();
    throw toCordieriteError(error);
  }
};
