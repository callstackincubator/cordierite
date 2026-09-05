/**
 * The auto-spawning RPC client library (ARCHITECTURE.md §4, §5) used by the CLI, MCP server, and
 * tests to talk to `daemon.sock`. On `ENOENT`/`ECONNREFUSED` it takes an exclusive spawn-lock,
 * spawns `daemon run` detached, polls the socket until ready, then retries the request once.
 */

import { connect, type Socket } from "node:net";
import { spawn as spawnChildProcess } from "node:child_process";
import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RPC_METHODS, type DaemonStatusResult, type RpcErrorData } from "@cordierite/shared";

import { getStateDirPaths, type StateDirPaths } from "../daemon/state-dir.js";
import { DAEMON_VERSION_OVERRIDE_ENV } from "../package-version.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultBinPath = join(packageRoot, "bin.js");

export type SpawnContext = {
  stateDir: string;
  logFilePath: string;
};

/** Spawns `daemon run` detached with stdio redirected to `daemon.log`. Injectable for tests. */
export type SpawnFn = (args: string[], context: SpawnContext) => void | Promise<void>;

export class DaemonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: RpcErrorData,
  ) {
    super(message);
    this.name = "DaemonRpcError";
  }
}

/**
 * `reason` distinguishes outcomes that look identical to a caller but mean opposite things to the
 * version-drift restart (issue #30): `"closed"` is the daemon dropping the connection — expected
 * while it tears itself down — whereas `"timeout"` is a daemon that is very much alive and simply
 * not answering, which must never be mistaken for "it is gone, spawn another one".
 */
export class DaemonUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "closed" | "unreachable" = "unreachable",
  ) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

/** A request that ran out of time against a daemon that never dropped the connection. */
const isRequestTimeoutError = (error: unknown): boolean => {
  return error instanceof DaemonUnavailableError && error.reason === "timeout";
};

/** What a restart would destroy, as read from one `daemon.status` reply. */
export type DaemonLiveState = {
  sessions: number;
  pendingLinks: number;
};

const describeLiveState = (state: DaemonLiveState): string => {
  const parts: string[] = [];

  if (state.sessions > 0) {
    parts.push(`${state.sessions} connected session(s)`);
  }

  if (state.pendingLinks > 0) {
    parts.push(`${state.pendingLinks} unclaimed link(s)`);
  }

  return parts.join(" and ");
};

/**
 * Raised when the daemon this client reached is running a different Cordierite version and could
 * not be replaced (issue #30). The common case is live state a restart would destroy: sessions
 * (resume tokens are in-daemon memory, so a restart makes the app's resume fail closed with 1008)
 * or pending links (a deep link or QR code someone is about to scan). The caller is told rather
 * than silently paying that cost.
 */
export class DaemonVersionMismatchError extends Error {
  readonly sessionCount: number;
  readonly pendingLinkCount: number;

  constructor(
    readonly daemonVersion: string,
    readonly clientVersion: string,
    live: DaemonLiveState,
    message?: string,
  ) {
    super(
      message ??
        `The running Cordierite daemon is version ${daemonVersion}, but this client is version ${clientVersion}. ` +
          `It was not restarted automatically because ${describeLiveState(live)} would be lost. ` +
          `Run "cordierite daemon stop" once that state is expendable, or force it with "--daemon-restart".`,
    );
    this.name = "DaemonVersionMismatchError";
    this.sessionCount = live.sessions;
    this.pendingLinkCount = live.pendingLinks;
  }
}

/**
 * Raised when the daemon *was* restarted and the replacement still reports a different version.
 * Retrying would just kill daemon after daemon, so the check stops after one restart and says what
 * it actually found — almost always two installs of the `cordierite` binary, where the one that
 * spawns the daemon is not the one running this command.
 */
export class DaemonVersionRestartIneffectiveError extends DaemonVersionMismatchError {
  constructor(daemonVersion: string, clientVersion: string, live: DaemonLiveState, binPath: string) {
    super(
      daemonVersion,
      clientVersion,
      live,
      `The Cordierite daemon was restarted to match this client (version ${clientVersion}), but the replacement reports version ${daemonVersion}. ` +
        `The daemon is spawned from "${binPath}", which is probably a different install than the one running this command ` +
        `(a project-local "node_modules/.bin/cordierite" alongside a global one, say). ` +
        `Run "cordierite daemon stop" and start the daemon from the install you intend to use.`,
    );
    this.name = "DaemonVersionRestartIneffectiveError";
  }
}

/**
 * Opt-in daemon/client version check (issue #30). Passed by the CLI dispatcher and the MCP
 * server's startup stream; deliberately *not* passed by `cordierite/client`, whose callers are
 * test processes that must never have a daemon restarted out from under a live app session.
 */
export type VersionCheckOptions = {
  /** The version this client actually is — always the real package version, never an override. */
  clientVersion: string;
  /** Restart even when the daemon has live sessions or pending links (`--daemon-restart`, the
   * `CORDIERITE_DAEMON_RESTART` env var, or `config.json`'s `restartDaemonOnVersionMismatch`). */
  forceRestart?: boolean;
  /** Where the "the daemon is newer than this client" notice goes. Defaults to `process.stderr` —
   * never stdout, which belongs to `--json` output and to the MCP transport's frames. */
  onWarning?: (message: string) => void;
};

// --- version comparison ------------------------------------------------------------------------

type ParsedVersion = { numbers: readonly number[]; prerelease: string | undefined };

/** Parses `1.2.3`, `1.2.3-beta.1`, `1.2.3+build`; `undefined` for anything else. */
const parseVersion = (value: string): ParsedVersion | undefined => {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim());

  if (!match) {
    return undefined;
  }

  return { numbers: match[1]!.split(".").map(Number), prerelease: match[2] };
};

/**
 * `-1` when `a` is older, `1` when newer, `0` when equivalent; `undefined` when either side is not
 * a version this can order. A prerelease sorts before the same numeric release (`1.0.0-rc` < `1.0.0`),
 * matching semver — which is what keeps a `-rc` build from restarting the release it is testing.
 */
const compareVersions = (a: string, b: string): number | undefined => {
  const left = parseVersion(a);
  const right = parseVersion(b);

  if (!left || !right) {
    return undefined;
  }

  const length = Math.max(left.numbers.length, right.numbers.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);

    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }

  if (left.prerelease === right.prerelease) {
    return 0;
  }

  if (left.prerelease === undefined) {
    return 1;
  }

  if (right.prerelease === undefined) {
    return -1;
  }

  return left.prerelease < right.prerelease ? -1 : 1;
};

export type CallDaemonOptions = {
  stateDir: string;
  /** Auto-spawn a daemon on `ENOENT`/`ECONNREFUSED`. Defaults to `true`. */
  autoSpawn?: boolean;
  spawn?: SpawnFn;
  /** Per-request timeout waiting for a response line. Defaults to 10s. */
  requestTimeoutMs?: number;
  /** How long to poll the socket for readiness after spawning. Defaults to 5000ms. */
  spawnWaitTimeoutMs?: number;
  /** Poll interval while waiting for the socket to become ready. Defaults to 100ms. */
  spawnPollIntervalMs?: number;
  /**
   * When set, the first call from this process to a given daemon socket compares the daemon's
   * version with {@link VersionCheckOptions.clientVersion} and restarts the daemon when they
   * differ and doing so is safe. The result is cached per socket path, so this costs one extra
   * `daemon.status` round-trip per process — not per request.
   */
  checkVersion?: VersionCheckOptions;
};

const isConnectionMissingError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
};

/**
 * True when `error` indicates the daemon is not reachable at all — no listener at the socket
 * path (`ENOENT`/`ECONNREFUSED`), or a `DaemonUnavailableError` from a request that timed out or
 * had its connection drop mid-flight. Callers use this to decide whether a fallback (e.g. `daemon
 * stop`'s SIGTERM-via-pidfile path) applies, as opposed to a `DaemonRpcError` from a daemon that
 * is very much running but rejected the request.
 */
export const isDaemonUnreachableError = (error: unknown): boolean => {
  return error instanceof DaemonUnavailableError || isConnectionMissingError(error);
};

let nextRequestId = 1;

const sendRequest = <TResult>(
  socketPath: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<TResult> => {
  return new Promise<TResult>((resolve, reject) => {
    const id = nextRequestId;
    nextRequestId += 1;

    let socket: Socket;
    let settled = false;
    let buffer = "";

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() =>
        reject(new DaemonUnavailableError(`Timed out waiting for a response to "${method}".`, "timeout")),
      );
    }, timeoutMs);

    socket = connect(socketPath);

    socket.on("error", (error) => {
      finish(() => reject(error));
    });

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (line.length === 0) {
          continue;
        }

        let message: { id?: unknown; result?: unknown; error?: { code: number; message: string; data?: RpcErrorData } };

        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id !== id) {
          continue;
        }

        if (message.error) {
          finish(() =>
            reject(new DaemonRpcError(message.error!.code, message.error!.message, message.error!.data)),
          );
          return;
        }

        finish(() => resolve(message.result as TResult));
        return;
      }
    });

    socket.on("close", () => {
      finish(() =>
        reject(new DaemonUnavailableError("Connection to the Cordierite daemon closed.", "closed")),
      );
    });
  });
};

const isSocketConnectable = (socketPath: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = connect(socketPath);

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const pollForSocket = async (
  socketPath: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isSocketConnectable(socketPath)) {
      return true;
    }

    await sleep(pollIntervalMs);
  }

  return isSocketConnectable(socketPath);
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const unlinkStaleSocketIfDaemonDead = async (paths: StateDirPaths): Promise<void> => {
  let pid: number | undefined;

  try {
    pid = Number.parseInt((await readFile(paths.pidFilePath, "utf8")).trim(), 10);
  } catch {
    pid = undefined;
  }

  if (pid === undefined || Number.isNaN(pid) || !isPidAlive(pid)) {
    await rm(paths.socketPath, { force: true });
  }
};

const defaultSpawn: SpawnFn = async (args, context) => {
  const logFd = await open(context.logFilePath, "a", 0o600);

  try {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, CORDIERITE_STATE_DIR: context.stateDir };
    // A daemon this client spawns must report its real version, whatever this process inherited.
    // Otherwise a stray `CORDIERITE_DAEMON_VERSION_OVERRIDE` in the operator's shell would be
    // copied into the replacement, which would then mismatch too — an endless restart loop.
    delete childEnv[DAEMON_VERSION_OVERRIDE_ENV];

    const child = spawnChildProcess(process.execPath, [defaultBinPath, ...args], {
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
      env: childEnv,
    });

    child.unref();
  } finally {
    await logFd.close();
  }
};

type SpawnDaemonOptions = {
  /**
   * Runs while this caller holds the exclusive spawn-lock, before the stale-socket cleanup and the
   * spawn itself. Returning `false` skips the spawn (the lock is still released and the socket is
   * still awaited) — the restart path uses that to bail out when another process turned out to
   * have already replaced the daemon while this one was queued on the lock.
   */
  beforeSpawn?: () => Promise<boolean>;
  /**
   * When this caller loses the spawn-lock race, wait for the lock to be released before polling
   * the socket. The default (`false`) only polls the socket, which is right for a plain spawn —
   * any listener at the path is the daemon we wanted. It is wrong for a *restart*, where the
   * socket may still belong to the very daemon the lock holder is in the middle of replacing.
   */
  awaitLockRelease?: boolean;
};

/**
 * How long a spawn-lock may be held before another process treats it as abandoned. A restart holds
 * the lock across a status read, a `daemon.shutdown`, and a wait for the daemon to disappear, so
 * the ceiling has to be generous — but a Ctrl-C in that window used to leave the lock behind
 * forever, and every later command would then quietly skip spawning and time out on a socket that
 * was never going to appear.
 */
const SPAWN_LOCK_STALE_MS = 30_000;

const pollUntilLockReleased = async (
  lockPath: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await pathExists(lockPath))) {
      return;
    }

    await sleep(pollIntervalMs);
  }
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Takes the exclusive spawn-lock, reclaiming one that has been held past
 * {@link SPAWN_LOCK_STALE_MS} (its owner died without cleaning up). The takeover is itself racy
 * only in the sense that two processes could reclaim the same abandoned lock in the same instant —
 * which lands them exactly where the plain double-spawn race already does, and the pidfile's
 * `O_EXCL` still decides the winner.
 */
const acquireSpawnLock = async (lockPath: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    let heldForMs: number;

    try {
      heldForMs = Date.now() - (await stat(lockPath)).mtimeMs;
    } catch {
      // Released between the failed create and the stat — go straight back and take it.
      continue;
    }

    if (heldForMs < SPAWN_LOCK_STALE_MS) {
      return false;
    }

    await rm(lockPath, { force: true });
  }

  return false;
};

/**
 * Takes the exclusive spawn-lock, spawns `daemon run` detached if this caller wins the race
 * (the loser just polls), then waits for the socket to become ready.
 */
const spawnDaemonAndWait = async (
  paths: StateDirPaths,
  spawn: SpawnFn,
  waitTimeoutMs: number,
  pollIntervalMs: number,
  options: SpawnDaemonOptions = {},
): Promise<void> => {
  const acquiredLock = await acquireSpawnLock(paths.spawnLockPath);

  if (acquiredLock) {
    try {
      const shouldSpawn = options.beforeSpawn ? await options.beforeSpawn() : true;

      if (shouldSpawn) {
        await unlinkStaleSocketIfDaemonDead(paths);
        await spawn(["daemon", "run"], { stateDir: paths.root, logFilePath: paths.logFilePath });
      }
    } finally {
      await rm(paths.spawnLockPath, { force: true });
    }
  } else if (options.awaitLockRelease) {
    await pollUntilLockReleased(paths.spawnLockPath, waitTimeoutMs, pollIntervalMs);
  }

  const ready = await pollForSocket(paths.socketPath, waitTimeoutMs, pollIntervalMs);

  if (!ready) {
    // A lock still sitting there is the single most useful thing to say here: it means another
    // process is (or died) mid-spawn, and this one deliberately did not spawn a second daemon.
    const lockHint = (await pathExists(paths.spawnLockPath))
      ? ` Another process holds the spawn-lock at "${paths.spawnLockPath}"; if no "cordierite daemon" is starting, delete it and retry.`
      : "";

    throw new DaemonUnavailableError(
      `Timed out waiting for the Cordierite daemon socket at "${paths.socketPath}".${lockHint}`,
    );
  }
};

// ---------------------------------------------------------------------------------------------
// Daemon/client version drift (issue #30, ARCHITECTURE.md §4)
// ---------------------------------------------------------------------------------------------

/**
 * One in-flight-or-settled check per daemon socket path, so the extra `daemon.status` costs one
 * round-trip per process and concurrent callers (e.g. the MCP server's stream plus a first
 * `tools.list`) share a single check and a single restart rather than racing each other.
 */
const versionChecks = new Map<string, Promise<void>>();

/** Test seam: drops the per-process check cache so each test case starts from a clean slate. */
export const resetDaemonVersionChecks = (): void => {
  versionChecks.clear();
};

/**
 * Per-call timeout for the `daemon.status` and `daemon.shutdown` requests issued *while the
 * spawn-lock is held*. Deliberately much shorter than the general request timeout: everything
 * between taking the lock and releasing it is time in which no other process can spawn a daemon,
 * and an unresponsive daemon must not stretch that into tens of seconds.
 */
const RESTART_REQUEST_TIMEOUT_MS = 3000;

type VersionCheckContext = {
  paths: StateDirPaths;
  spawn: SpawnFn;
  autoSpawn: boolean;
  requestTimeoutMs: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  check: VersionCheckOptions;
};

/**
 * `daemon.status`, auto-spawning a daemon first when nothing is listening. Returns `undefined`
 * when nothing is listening and auto-spawn is off — there is no daemon to drift from, and any
 * daemon this process spawns later is by definition this process's own build.
 */
const readStatusSpawningIfNeeded = async (
  context: VersionCheckContext,
): Promise<DaemonStatusResult | undefined> => {
  try {
    return await sendRequest<DaemonStatusResult>(
      context.paths.socketPath,
      RPC_METHODS.daemonStatus,
      {},
      context.requestTimeoutMs,
    );
  } catch (error) {
    if (!isConnectionMissingError(error)) {
      throw error;
    }

    if (!context.autoSpawn) {
      return undefined;
    }

    await spawnDaemonAndWait(context.paths, context.spawn, context.waitTimeoutMs, context.pollIntervalMs);

    return sendRequest<DaemonStatusResult>(
      context.paths.socketPath,
      RPC_METHODS.daemonStatus,
      {},
      context.requestTimeoutMs,
    );
  }
};

/**
 * `daemon.status` against whatever is listening right now; `undefined` only when nothing is
 * listening at all. A *timeout* is not "gone" — it is a daemon that is alive and busy, and
 * spawning a second one over it would be the worst possible response — so it aborts the restart
 * with a message that says so.
 */
const readStatusIfReachable = async (
  context: VersionCheckContext,
): Promise<DaemonStatusResult | undefined> => {
  try {
    return await sendRequest<DaemonStatusResult>(
      context.paths.socketPath,
      RPC_METHODS.daemonStatus,
      {},
      RESTART_REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    if (isConnectionMissingError(error)) {
      return undefined;
    }

    if (isRequestTimeoutError(error)) {
      throw new DaemonUnavailableError(
        `The Cordierite daemon at "${context.paths.socketPath}" did not answer "daemon.status" within ${RESTART_REQUEST_TIMEOUT_MS}ms, so it was not replaced. ` +
          `It is running but unresponsive — run "cordierite daemon stop" and retry.`,
        "timeout",
      );
    }

    throw error;
  }
};

/**
 * True once nothing can answer at the socket *and* the pidfile no longer names a live process.
 * Both halves matter: the daemon closes its listener before releasing the pidfile, so a fresh
 * daemon spawned on "socket is gone" alone can lose the pidfile's `O_EXCL` race against the
 * outgoing one and die with `DaemonAlreadyRunningError`.
 */
const isDaemonGone = async (paths: StateDirPaths): Promise<boolean> => {
  if (await isSocketConnectable(paths.socketPath)) {
    return false;
  }

  let pid: number | undefined;

  try {
    pid = Number.parseInt((await readFile(paths.pidFilePath, "utf8")).trim(), 10);
  } catch {
    return true;
  }

  return pid === undefined || Number.isNaN(pid) || !isPidAlive(pid);
};

/**
 * What a restart of this daemon would destroy. Defensive about both fields' presence rather than
 * indexing them blindly: `pendingLinks` is absent from daemons older than 0.8.0 (and drift with an
 * older daemon is the whole point of this code path), and a `TypeError` from deep inside the
 * version check would be a far worse diagnosis than the drift it was trying to report.
 */
const readLiveState = (status: DaemonStatusResult): DaemonLiveState => {
  return {
    sessions: Array.isArray(status.sessions) ? status.sessions.length : 0,
    pendingLinks: typeof status.pendingLinks === "number" ? status.pendingLinks : 0,
  };
};

const isSafeToRestart = (live: DaemonLiveState): boolean => {
  return live.sessions === 0 && live.pendingLinks === 0;
};

const pollUntilDaemonGone = async (
  paths: StateDirPaths,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isDaemonGone(paths)) {
      return true;
    }

    await sleep(pollIntervalMs);
  }

  return isDaemonGone(paths);
};

/**
 * Replaces the running daemon with one spawned from this client's build. Runs under the same
 * exclusive spawn-lock as a cold-start spawn, so two upgraded CLIs starting at once produce one
 * replacement daemon, not two — and the loser waits for the lock rather than for a socket that
 * may still be the outgoing daemon's.
 */
const restartDaemon = async (context: VersionCheckContext): Promise<void> => {
  await spawnDaemonAndWait(
    context.paths,
    context.spawn,
    context.waitTimeoutMs,
    context.pollIntervalMs,
    {
      awaitLockRelease: true,
      beforeSpawn: async () => {
        // Re-read under the lock: another process may have replaced the daemon while this one was
        // queued, and a session or link may have appeared since the status read that decided a
        // restart was safe. (Not fully atomic — the daemon has no compare-and-shutdown — but it
        // closes the window that a slow lock wait would otherwise leave wide open.)
        const status = await readStatusIfReachable(context);

        if (status === undefined) {
          return true;
        }

        if (status.version === context.check.clientVersion) {
          return false;
        }

        const live = readLiveState(status);

        if (!isSafeToRestart(live) && !context.check.forceRestart) {
          throw new DaemonVersionMismatchError(status.version, context.check.clientVersion, live);
        }

        try {
          await sendRequest(
            context.paths.socketPath,
            RPC_METHODS.daemonShutdown,
            {},
            RESTART_REQUEST_TIMEOUT_MS,
          );
        } catch (error) {
          if (isRequestTimeoutError(error)) {
            throw new DaemonUnavailableError(
              `The Cordierite daemon at "${context.paths.socketPath}" did not acknowledge "daemon.shutdown" within ${RESTART_REQUEST_TIMEOUT_MS}ms, so it was left running. ` +
                `Run "cordierite daemon stop" and retry.`,
              "timeout",
            );
          }

          // The daemon answers `shutdown` before teardown finishes, so a connection that is
          // already gone (or drops mid-reply) is an ordinary outcome; the poll below is what
          // actually establishes it left.
          if (!isDaemonUnreachableError(error)) {
            throw error;
          }
        }

        if (!(await pollUntilDaemonGone(context.paths, context.waitTimeoutMs, context.pollIntervalMs))) {
          throw new DaemonUnavailableError(
            `The Cordierite daemon at "${context.paths.socketPath}" did not shut down in time; run "cordierite daemon stop" and retry.`,
          );
        }

        return true;
      },
    },
  );
};

const warnOlderClient = (context: VersionCheckContext, daemonVersion: string): void => {
  const message =
    `cordierite: the running daemon is version ${daemonVersion}, newer than this client (${context.check.clientVersion}). ` +
    `Continuing without restarting it — a newer daemon serves an older client, and replacing it would downgrade whatever started it. ` +
    `Run "cordierite daemon stop" if you want this client's daemon instead.\n`;

  const warn = context.check.onWarning ?? ((text: string) => void process.stderr.write(text));
  warn(message);
};

/**
 * Compares the daemon's version with this client's and, at most **once** per process, replaces a
 * daemon this client has outgrown.
 *
 * One restart, never a loop: each restart destroys whatever the daemon was holding, so retrying a
 * restart that did not take effect just kills daemon after daemon while reporting a cause that was
 * never true. If the replacement still disagrees, that is a different problem with a different
 * answer ({@link DaemonVersionRestartIneffectiveError}).
 */
const runVersionCheck = async (context: VersionCheckContext): Promise<void> => {
  const status = await readStatusSpawningIfNeeded(context);

  if (status === undefined) {
    return;
  }

  if (status.version === context.check.clientVersion) {
    return;
  }

  // Direction matters. Restarting is only ever right when this client has outgrown the daemon;
  // a *newer* daemon already speaks everything this client knows, and replacing it would
  // downgrade the daemon out from under whichever newer install started it — two installs on one
  // machine would otherwise take turns killing each other's daemon on every command.
  if ((compareVersions(context.check.clientVersion, status.version) ?? -1) <= 0) {
    warnOlderClient(context, status.version);
    return;
  }

  const live = readLiveState(status);

  if (!isSafeToRestart(live) && !context.check.forceRestart) {
    throw new DaemonVersionMismatchError(status.version, context.check.clientVersion, live);
  }

  await restartDaemon(context);

  const replacement = await readStatusIfReachable(context);

  if (replacement === undefined) {
    throw new DaemonUnavailableError(
      `The Cordierite daemon was restarted but nothing is listening at "${context.paths.socketPath}"; check "${context.paths.logFilePath}".`,
    );
  }

  if (replacement.version === context.check.clientVersion) {
    return;
  }

  if ((compareVersions(context.check.clientVersion, replacement.version) ?? -1) < 0) {
    warnOlderClient(context, replacement.version);
    return;
  }

  throw new DaemonVersionRestartIneffectiveError(
    replacement.version,
    context.check.clientVersion,
    readLiveState(replacement),
    defaultBinPath,
  );
};

/**
 * Runs {@link runVersionCheck} at most once per process per daemon socket. A mismatch that could
 * not be resolved stays cached (every later call in this process would reach the same daemon and
 * fail the same way); a transient failure does not, so a retry can still succeed.
 */
const ensureDaemonVersion = async (
  paths: StateDirPaths,
  options: CallDaemonOptions,
  spawn: SpawnFn,
): Promise<void> => {
  const check = options.checkVersion;

  if (!check) {
    return;
  }

  const cached = versionChecks.get(paths.socketPath);

  if (cached) {
    return cached;
  }

  const pending = runVersionCheck({
    paths,
    spawn,
    autoSpawn: options.autoSpawn ?? true,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    waitTimeoutMs: options.spawnWaitTimeoutMs ?? 5000,
    pollIntervalMs: options.spawnPollIntervalMs ?? 100,
    check,
  }).catch((error: unknown) => {
    if (!(error instanceof DaemonVersionMismatchError)) {
      versionChecks.delete(paths.socketPath);
    }

    throw error;
  });

  versionChecks.set(paths.socketPath, pending);

  return pending;
};

/**
 * Runs the version check on its own, without issuing a command RPC — the CLI dispatcher's seam
 * (issue #30). Pass `autoSpawn: false` (the default here) when the caller does not want a daemon
 * started just to be checked: nothing listening means nothing to drift from.
 */
export const ensureDaemonVersionMatches = async (
  options: Omit<CallDaemonOptions, "checkVersion"> & { checkVersion: VersionCheckOptions },
): Promise<void> => {
  const paths = getStateDirPaths(options.stateDir);

  await ensureDaemonVersion(
    paths,
    { ...options, autoSpawn: options.autoSpawn ?? false },
    options.spawn ?? defaultSpawn,
  );
};

/** Calls a daemon RPC method, auto-spawning the daemon on a missing/refused connection. */
export const callDaemon = async <TResult>(
  method: string,
  params: unknown,
  options: CallDaemonOptions,
): Promise<TResult> => {
  const paths = getStateDirPaths(options.stateDir);
  const autoSpawn = options.autoSpawn ?? true;
  const spawn = options.spawn ?? defaultSpawn;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  // Runs before the request so this call is answered by a daemon of the right version — never
  // half-answered by the outgoing one.
  await ensureDaemonVersion(paths, options, spawn);

  try {
    return await sendRequest<TResult>(paths.socketPath, method, params, requestTimeoutMs);
  } catch (error) {
    if (!autoSpawn || !isConnectionMissingError(error)) {
      throw error;
    }

    await spawnDaemonAndWait(
      paths,
      spawn,
      options.spawnWaitTimeoutMs ?? 5000,
      options.spawnPollIntervalMs ?? 100,
    );

    return sendRequest<TResult>(paths.socketPath, method, params, requestTimeoutMs);
  }
};

export type DaemonStream = {
  /** Sends a request over the persistent connection and awaits its response. `timeoutMs`
   * overrides this stream's default transport timeout for this call only — needed when a
   * request's own server-side deadline (e.g. `tools.call`'s `timeoutMs` param) can exceed the
   * stream's default, so the transport timeout never fires before the server-side one does. */
  call: <TResult>(method: string, params?: unknown, timeoutMs?: number) => Promise<TResult>;
  /** Subscribes to server→client `"event"` notifications; returns an unsubscribe function. */
  onNotification: (callback: (payload: unknown) => void) => () => void;
  /** Fires once when the underlying socket closes (daemon gone, stop(), etc.); returns an
   * unsubscribe function. Lets long-lived stream consumers (e.g. `cordierite events`) end
   * gracefully instead of hanging once the connection is no longer usable. */
  onClose: (callback: () => void) => () => void;
  close: () => void;
};

/**
 * Opens a persistent connection to the daemon (auto-spawning as needed) for use cases that need
 * server→client notifications, e.g. `events.subscribe`.
 */
export const openDaemonStream = async (
  options: Omit<CallDaemonOptions, "requestTimeoutMs"> & { requestTimeoutMs?: number },
): Promise<DaemonStream> => {
  const paths = getStateDirPaths(options.stateDir);
  const autoSpawn = options.autoSpawn ?? true;
  const spawn = options.spawn ?? defaultSpawn;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  const connectSocket = (): Promise<Socket> => {
    return new Promise((resolve, reject) => {
      const socket = connect(paths.socketPath);

      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(socket);
      });

      const onError = (error: Error): void => {
        reject(error);
      };

      socket.once("error", onError);
    });
  };

  // Resolved before the stream's socket is opened, so the connection this stream keeps for its
  // whole life belongs to a daemon of the right version and no caller ever observes two daemons.
  await ensureDaemonVersion(paths, options, spawn);

  let socket: Socket;

  try {
    socket = await connectSocket();
  } catch (error) {
    if (!autoSpawn || !isConnectionMissingError(error)) {
      throw error;
    }

    await spawnDaemonAndWait(
      paths,
      spawn,
      options.spawnWaitTimeoutMs ?? 5000,
      options.spawnPollIntervalMs ?? 100,
    );

    socket = await connectSocket();
  }

  socket.on("error", () => {
    // A stream consumer observes loss via `close`; never let a socket error crash the process.
  });

  const notificationListeners = new Set<(payload: unknown) => void>();
  const closeListeners = new Set<() => void>();
  const pendingCalls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timeout: NodeJS.Timeout }
  >();
  let buffer = "";

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");

    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (line.length === 0) {
        continue;
      }

      let message: {
        id?: unknown;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { code: number; message: string; data?: RpcErrorData };
      };

      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (message.method === "event") {
        for (const listener of notificationListeners) {
          try {
            listener(message.params);
          } catch {
            // A misbehaving subscriber (e.g. a throwing `waitForEvent` match predicate) must never
            // crash this loop — it would drop every other listener's notification, and any RPC
            // response batched in the same chunk, for the rest of this connection's lifetime.
          }
        }
        continue;
      }

      const pending = typeof message.id === "number" ? pendingCalls.get(message.id) : undefined;

      if (!pending) {
        continue;
      }

      pendingCalls.delete(message.id as number);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new DaemonRpcError(message.error.code, message.error.message, message.error.data));
      } else {
        pending.resolve(message.result);
      }
    }
  });

  socket.on("close", () => {
    for (const [, pending] of pendingCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new DaemonUnavailableError("Connection to the Cordierite daemon closed.", "closed"));
    }

    pendingCalls.clear();

    for (const listener of closeListeners) {
      listener();
    }
  });

  return {
    call: <TResult>(method: string, params?: unknown, timeoutMs?: number) => {
      return new Promise<TResult>((resolve, reject) => {
        const id = nextRequestId;
        nextRequestId += 1;

        const timeout = setTimeout(() => {
          pendingCalls.delete(id);
          reject(new DaemonUnavailableError(`Timed out waiting for a response to "${method}".`, "timeout"));
        }, timeoutMs ?? requestTimeoutMs);

        pendingCalls.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout,
        });

        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    onNotification: (callback) => {
      notificationListeners.add(callback);
      return () => {
        notificationListeners.delete(callback);
      };
    },
    onClose: (callback) => {
      closeListeners.add(callback);
      return () => {
        closeListeners.delete(callback);
      };
    },
    close: () => {
      socket.destroy();
    },
  };
};
