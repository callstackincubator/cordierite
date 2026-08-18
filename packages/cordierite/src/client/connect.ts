/**
 * `connect()` (issue #8): the entry point for a test runner that wants to drive an already-claimed
 * session without shelling out to the CLI. Auto-spawns the daemon (same seam `rpc/client.ts` gives
 * the CLI/MCP server) and resolves `selector` up front via `sessions.describe` so a bad/ambiguous
 * selector fails fast with a typed {@link CordieriteError} rather than surfacing on the first
 * `call()`.
 */
import { RPC_METHODS, type SessionsDescribeResult } from "@cordierite/shared";

import { resolveStateDir } from "../daemon/state-dir.js";
import { openDaemonStream, type DaemonStream, type SpawnFn } from "../rpc/client.js";
import { makeAppClient, type AppClient, type ToolMap } from "./app-client.js";
import { toCordieriteError } from "./errors.js";

export type ConnectOptions = {
  /** Session id or alias; omitted selects the sole active/suspended session (rejects with
   * `"no_session"`/`"ambiguous_session"` otherwise — the same rule the CLI/MCP surfaces use). */
  selector?: string;
  /** Defaults to `CORDIERITE_STATE_DIR`, else `~/.cordierite` — the same resolution the CLI uses. */
  stateDir?: string;
  /** Injectable daemon-spawn seam (tests only); real callers never need this. */
  spawn?: SpawnFn;
  /** Auto-spawn a daemon on a missing connection. Defaults to `true`. */
  autoSpawn?: boolean;
  requestTimeoutMs?: number;
};

/** Opens a persistent connection to the daemon and resolves `options.selector` to one session. */
export const connect = async <TTools = ToolMap>(
  options: ConnectOptions = {},
): Promise<AppClient<TTools>> => {
  const stateDir = resolveStateDir(options.stateDir);

  let stream: DaemonStream;

  try {
    stream = await openDaemonStream({
      stateDir,
      spawn: options.spawn,
      autoSpawn: options.autoSpawn,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  } catch (error) {
    throw toCordieriteError(error);
  }

  try {
    const detail = await stream.call<SessionsDescribeResult>(RPC_METHODS.sessionsDescribe, {
      selector: options.selector,
    });

    return makeAppClient<TTools>(stream, detail.sessionId);
  } catch (error) {
    stream.close();
    throw toCordieriteError(error);
  }
};
