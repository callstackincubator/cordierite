import { RPC_METHODS, type DaemonShutdownResult, type DaemonStatusResult } from "@cordierite/shared";

import type {
  CliResult,
  DaemonRunCommandData,
  DaemonStartCommandData,
  DaemonStatusCommandData,
  DaemonStopCommandData,
} from "../cli/result-types.js";
import type { Clock } from "../cli/types.js";
import { startDaemon } from "../daemon/daemon.js";
import { DaemonAlreadyRunningError, readPidFromFile } from "../daemon/pidfile.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import { connectionError } from "../errors.js";
import { getPackageVersion } from "../package-version.js";
import { callDaemon, isDaemonUnreachableError, isSameVersion, type SpawnFn } from "../rpc/client.js";

export type DaemonCommandContext = {
  stateDir: string;
  clock?: Clock;
  spawn?: SpawnFn;
  warn?: (message: string) => void;
  /** Test seam: the version `daemon status` compares the daemon against; defaults to this
   * package's own version. */
  clientVersion?: string;
};

export type DaemonRunHostedResult = {
  result: CliResult<DaemonRunCommandData>;
  completion: Promise<void>;
  stop: () => void;
};

export const handleDaemonRunCommand = async (
  context: DaemonCommandContext,
): Promise<DaemonRunHostedResult> => {
  let daemon: Awaited<ReturnType<typeof startDaemon>>;

  try {
    daemon = await startDaemon({
      stateDir: context.stateDir,
      clock: context.clock,
      warn: context.warn,
    });
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      throw connectionError(error.message, { pid: error.pid });
    }

    throw error;
  }

  return {
    result: {
      ok: true,
      data: {
        daemon: {
          pid: process.pid,
          state_dir: daemon.paths.root,
          socket_path: daemon.paths.socketPath,
        },
      },
    },
    completion: daemon.exited,
    stop: () => {
      void daemon.shutdown();
    },
  };
};

export const handleDaemonStartCommand = async (
  context: DaemonCommandContext,
): Promise<CliResult<DaemonStartCommandData>> => {
  const status = await callDaemon<DaemonStatusResult>(
    RPC_METHODS.daemonStatus,
    {},
    { stateDir: context.stateDir, autoSpawn: true, spawn: context.spawn },
  );

  return {
    ok: true,
    data: {
      daemon: {
        pid: status.pid,
        wss_port: status.wssPort,
        started_at: status.startedAt,
      },
    },
  };
};

export const handleDaemonStopCommand = async (
  context: DaemonCommandContext,
): Promise<CliResult<DaemonStopCommandData>> => {
  try {
    await callDaemon<DaemonShutdownResult>(
      RPC_METHODS.daemonShutdown,
      {},
      { stateDir: context.stateDir, autoSpawn: false },
    );

    return { ok: true, data: { daemon: { ok: true, method: "rpc" } } };
  } catch (error) {
    if (!isDaemonUnreachableError(error)) {
      throw error;
    }

    const paths = getStateDirPaths(context.stateDir);
    const pid = await readPidFromFile(paths.pidFilePath);

    if (pid === undefined) {
      throw connectionError("No Cordierite daemon is running.");
    }

    process.kill(pid, "SIGTERM");

    return { ok: true, data: { daemon: { ok: true, method: "sigterm" } } };
  }
};

export const handleDaemonStatusCommand = async (
  context: DaemonCommandContext,
): Promise<CliResult<DaemonStatusCommandData>> => {
  const status = await callDaemon<DaemonStatusResult>(
    RPC_METHODS.daemonStatus,
    {},
    { stateDir: context.stateDir, autoSpawn: true, spawn: context.spawn },
  );

  const clientVersion = context.clientVersion ?? getPackageVersion();
  // Guarded the same way the version check guards it (`rpc/client.ts`): a `daemon.status` without
  // `sessions` would otherwise throw from the middle of the command that exists to diagnose a
  // daemon — the one command that must keep working against a daemon it does not fully understand.
  const sessionCount = Array.isArray(status.sessions) ? status.sessions.length : 0;
  const pendingLinkCount = typeof status.pendingLinks === "number" ? status.pendingLinks : 0;
  // Names the same cost the restart path names (`rpc/client.ts`), so the diagnosis an operator
  // reads here and the error they hit on the next command tell one consistent story: an unclaimed
  // link is destroyed by a restart just as surely as a session is.
  const atStake = `${sessionCount} session(s) and ${pendingLinkCount} unclaimed link(s)`;
  const warning = isSameVersion(status.version, clientVersion)
    ? undefined
    : `Version drift: this daemon is ${status.version} but the CLI is ${clientVersion}. ` +
      `Newer RPC methods will fail against it — run "cordierite daemon stop" (this drops ${atStake}) ` +
      `and the next command will start a matching daemon, or pass "--daemon-restart" to any command to replace it in place.`;

  return {
    ok: true,
    data: {
      warning,
      daemon: {
        version: status.version,
        pid: status.pid,
        started_at: status.startedAt,
        wss_port: status.wssPort,
        pinned_keys: status.pinnedKeys,
        session_count: sessionCount,
      },
      policy: status.policy,
      audit: { path: status.audit.path, failed_writes: status.audit.failedWrites },
    },
  };
};

