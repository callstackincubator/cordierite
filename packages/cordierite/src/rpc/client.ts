/**
 * The auto-spawning RPC client library (ARCHITECTURE.md §4, §5) used by the CLI, MCP server, and
 * tests to talk to `daemon.sock`. On `ENOENT`/`ECONNREFUSED` it takes an exclusive spawn-lock,
 * spawns `daemon run` detached, polls the socket until ready, then retries the request once.
 */

import { connect, type Socket } from "node:net";
import { spawn as spawnChildProcess } from "node:child_process";
import { open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RpcErrorData } from "@cordierite/shared";

import {
  ensureDaemonLogMode,
  resolveDaemonLogMaxBytes,
  rotateDaemonLogIfNeeded,
} from "../daemon/log-rotation.js";
import { isProcessAlive } from "../daemon/pidfile.js";
import { isSocketConnectable } from "../daemon/socket-probe.js";
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

const unlinkStaleSocketIfDaemonDead = async (paths: StateDirPaths): Promise<void> => {
  let pid: number | undefined;

  try {
    pid = Number.parseInt((await readFile(paths.pidFilePath, "utf8")).trim(), 10);
  } catch {
    pid = undefined;
  }

  if (pid === undefined || Number.isNaN(pid) || !isProcessAlive(pid)) {
    await rm(paths.socketPath, { force: true });
  }
};

const defaultSpawn: SpawnFn = async (args, context) => {
  // Rotate before the new daemon's log fd is opened (issue #32). This is the only safe moment:
  // afterwards the daemon holds the fd for its whole life. `cordierite daemon start` spawns
  // through this same path, so it rotates too. Reaching here means nothing answered the socket,
  // which is *usually* but not always the same as "no daemon is writing this log" — hence the
  // pidfile and socket guards inside, which decline to rotate under a daemon that is still there.
  const paths = getStateDirPaths(context.stateDir);

  await rotateDaemonLogIfNeeded({
    logFilePath: context.logFilePath,
    maxBytes: await resolveDaemonLogMaxBytes(context.stateDir),
    pidFilePath: paths.pidFilePath,
    socketPath: paths.socketPath,
  });

  const logFd = await open(context.logFilePath, "a", 0o600);

  try {
    // Best-effort, never fatal: this is the auto-spawn path, and a log mode that cannot be
    // tightened is not a reason to fail every command that needs a daemon. See the helper.
    await ensureDaemonLogMode(context.logFilePath);

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

/**
 * Takes the exclusive spawn-lock, spawns `daemon run` detached if this caller wins the race
 * (the loser just polls), then waits for the socket to become ready.
 */
const spawnDaemonAndWait = async (
  paths: StateDirPaths,
  spawn: SpawnFn,
  waitTimeoutMs: number,
  pollIntervalMs: number,
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
      await unlinkStaleSocketIfDaemonDead(paths);
      await spawn(["daemon", "run"], { stateDir: paths.root, logFilePath: paths.logFilePath });
    } finally {
      await rm(paths.spawnLockPath, { force: true });
    }
  }

  const ready = await pollForSocket(paths.socketPath, waitTimeoutMs, pollIntervalMs);

  if (!ready) {
    throw new DaemonUnavailableError(
      `Timed out waiting for the Cordierite daemon socket at "${paths.socketPath}".`,
    );
  }
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
