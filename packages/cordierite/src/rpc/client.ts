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

export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

/**
 * Raised when the daemon this client reached is running a different Cordierite version and could
 * not be restarted safely — i.e. it still has live sessions and no force knob was given (issue
 * #30). Restarting drops every session (resume tokens are in-memory; ARCHITECTURE.md §4), so the
 * caller is told rather than silently costing the operator their connected devices.
 */
export class DaemonVersionMismatchError extends Error {
  constructor(
    readonly daemonVersion: string,
    readonly clientVersion: string,
    readonly sessionCount: number,
  ) {
    super(
      `The running Cordierite daemon is version ${daemonVersion}, but this client is version ${clientVersion}. ` +
        `It was not restarted automatically because ${sessionCount} session(s) are still connected and a restart drops them. ` +
        `Run "cordierite daemon stop" once the sessions are expendable, or force it with "--daemon-restart".`,
    );
    this.name = "DaemonVersionMismatchError";
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
  /** Restart on mismatch even when sessions are live (`--daemon-restart`, config, env). */
  forceRestart?: boolean;
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
      finish(() => reject(new DaemonUnavailableError(`Timed out waiting for a response to "${method}".`)));
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
      finish(() => reject(new DaemonUnavailableError("Connection to the Cordierite daemon closed.")));
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
    const child = spawnChildProcess(process.execPath, [defaultBinPath, ...args], {
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
      env: { ...process.env, CORDIERITE_STATE_DIR: context.stateDir },
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
  let acquiredLock = false;

  try {
    const lockHandle = await open(paths.spawnLockPath, "wx", 0o600);
    await lockHandle.close();
    acquiredLock = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

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
    throw new DaemonUnavailableError(
      `Timed out waiting for the Cordierite daemon socket at "${paths.socketPath}".`,
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

/** How many times the check will re-read status and restart before giving up and reporting the
 * mismatch. >1 only matters when several processes race to replace the same daemon. */
const MAX_VERSION_CHECK_ATTEMPTS = 3;

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

/** `daemon.status` against whatever is listening right now; `undefined` when nothing is. */
const readStatusIfReachable = async (
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
    if (isDaemonUnreachableError(error)) {
      return undefined;
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
 * How many sessions a restart would drop. Defensive about the field's presence rather than
 * indexing it blindly: a daemon old enough to answer `daemon.status` without `sessions` predates
 * the persistent daemon entirely, and a `TypeError` from deep inside the version check would be a
 * far worse diagnosis than the drift it was trying to report.
 */
const liveSessionCount = (status: DaemonStatusResult): number => {
  return Array.isArray(status.sessions) ? status.sessions.length : 0;
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
        // queued, and a session may have been claimed since the status read that decided a restart
        // was safe. (Not fully atomic — the daemon has no compare-and-shutdown — but it closes the
        // window that a slow lock wait would otherwise leave wide open.)
        const status = await readStatusIfReachable(context);

        if (status === undefined) {
          return true;
        }

        if (status.version === context.check.clientVersion) {
          return false;
        }

        if (liveSessionCount(status) > 0 && !context.check.forceRestart) {
          throw new DaemonVersionMismatchError(
            status.version,
            context.check.clientVersion,
            liveSessionCount(status),
          );
        }

        try {
          await sendRequest(
            context.paths.socketPath,
            RPC_METHODS.daemonShutdown,
            {},
            context.requestTimeoutMs,
          );
        } catch (error) {
          // `daemon.shutdown` answers before teardown finishes, so a dropped connection here is
          // an ordinary outcome; the poll below is what actually establishes the daemon is gone.
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

const runVersionCheck = async (context: VersionCheckContext): Promise<void> => {
  let lastStatus: DaemonStatusResult | undefined;

  for (let attempt = 0; attempt < MAX_VERSION_CHECK_ATTEMPTS; attempt += 1) {
    const status = await readStatusSpawningIfNeeded(context);

    if (status === undefined) {
      return;
    }

    lastStatus = status;

    if (status.version === context.check.clientVersion) {
      return;
    }

    if (liveSessionCount(status) > 0 && !context.check.forceRestart) {
      throw new DaemonVersionMismatchError(
        status.version,
        context.check.clientVersion,
        liveSessionCount(status),
      );
    }

    await restartDaemon(context);
  }

  throw new DaemonVersionMismatchError(
    lastStatus?.version ?? "unknown",
    context.check.clientVersion,
    lastStatus ? liveSessionCount(lastStatus) : 0,
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
      pending.reject(new DaemonUnavailableError("Connection to the Cordierite daemon closed."));
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
          reject(new DaemonUnavailableError(`Timed out waiting for a response to "${method}".`));
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
