/**
 * Daemon composition root (ARCHITECTURE.md §4): state dir → config → pidfile → RPC server.
 * Implements `daemon.status` and `daemon.shutdown`. Sessions/links/tools/TLS land in tasks 04-05;
 * `daemon.status` reports empty placeholders for those until then.
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RPC_METHODS, type DaemonShutdownResult, type DaemonStatusResult } from "@cordierite/shared";

import type { Clock } from "../cli/types.js";
import { loadConfig, type CordieriteConfig, type ConfigWarnFn } from "./config.js";
import { acquirePidfile, type PidfileHandle } from "./pidfile.js";
import { startRpcServer, type RpcServer } from "./rpc-server.js";
import { ensureStateDir, getSocketPath, getStateDirPaths, type StateDirPaths } from "./state-dir.js";

const packageVersion: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
).version;

export type DaemonOptions = {
  stateDir: string;
  clock?: Clock;
  warn?: ConfigWarnFn;
};

export type RunningDaemon = {
  paths: StateDirPaths;
  config: CordieriteConfig;
  startedAt: Date;
  server: RpcServer;
  /** Resolves once graceful teardown (RPC close, pidfile release, socket unlink) completes. */
  exited: Promise<void>;
  /** Idempotent graceful teardown: closes the RPC server, releases the pidfile, unlinks the socket. */
  shutdown: () => Promise<void>;
};

const buildStatusResult = (
  paths: StateDirPaths,
  config: CordieriteConfig,
  startedAt: Date,
): DaemonStatusResult => {
  return {
    version: packageVersion,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    wssPort: config.wssPort,
    // Populated once the TLS listener + key pinning land (task 04).
    pinnedKeys: [],
    // Populated once the session engine lands (task 04/05).
    sessions: [],
  };
};

export const startDaemon = async (options: DaemonOptions): Promise<RunningDaemon> => {
  const clock = options.clock ?? { now: () => new Date() };
  const paths = getStateDirPaths(options.stateDir);

  await ensureStateDir(options.stateDir);

  const config = await loadConfig(paths, { warn: options.warn });
  const startedAt = clock.now();

  let pidfile: PidfileHandle | undefined;
  let server: RpcServer | undefined;
  let shuttingDown = false;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return exited;
    }

    shuttingDown = true;

    try {
      await server?.close();
      await pidfile?.release();
      await rm(getSocketPath(paths), { force: true });
    } finally {
      resolveExited();
    }
  };

  try {
    pidfile = await acquirePidfile(paths.pidFilePath, {
      onStaleTakeover: async () => {
        await rm(getSocketPath(paths), { force: true });
      },
    });

    server = await startRpcServer({
      socketPath: getSocketPath(paths),
      dispatch: {
        [RPC_METHODS.daemonStatus]: (): DaemonStatusResult => {
          return buildStatusResult(paths, config, startedAt);
        },
        [RPC_METHODS.daemonShutdown]: (_params, context): DaemonShutdownResult => {
          context.afterSend(() => {
            void shutdown();
          });

          return { ok: true };
        },
      },
    });
  } catch (error) {
    // Never leave a half-acquired pidfile/socket behind when startup fails partway through.
    await pidfile?.release();
    throw error;
  }

  return {
    paths,
    config,
    startedAt,
    server,
    exited,
    shutdown,
  };
};
