/**
 * Daemon composition root (ARCHITECTURE.md §4): state dir → config → pidfile → TLS → session
 * engine → listener → RPC server. Implements `daemon.status`/`daemon.shutdown` plus the session
 * RPC surface (`link.create`, `sessions.list`, `sessions.describe`, `sessions.revoke`); `tools.*`
 * and `events.subscribe` land in task 05.
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RPC_METHODS,
  type DaemonShutdownResult,
  type DaemonStatusResult,
  type LinkCreateParams,
  type LinkCreateResult,
  type SessionsDescribeResult,
  type SessionsListResult,
  type SessionsRevokeResult,
} from "@cordierite/shared";

import type { Clock } from "../cli/types.js";
import { detectAdvertisedAddress } from "./address.js";
import { loadConfig, type CordieriteConfig, type ConfigWarnFn } from "./config.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import { startListener, type DaemonListener } from "./listener.js";
import { acquirePidfile, type PidfileHandle } from "./pidfile.js";
import { RpcApplicationError, startRpcServer, type RpcServer } from "./rpc-server.js";
import { createSessionManager, type SessionManager } from "./sessions.js";
import { ensureStateDir, getSocketPath, getStateDirPaths, type StateDirPaths } from "./state-dir.js";
import { createTlsManager, toAgentEndpoint, type TlsManager } from "./tls.js";

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
  listener: DaemonListener;
  eventBus: EventBus;
  /** Resolves once graceful teardown (sockets closed, RPC/listener closed, pidfile released) completes. */
  exited: Promise<void>;
  /** Idempotent graceful teardown. */
  shutdown: () => Promise<void>;
};

const buildStatusResult = (
  config: CordieriteConfig,
  startedAt: Date,
  tls: TlsManager,
  sessionManager: SessionManager,
): DaemonStatusResult => {
  return {
    version: packageVersion,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    wssPort: config.wssPort,
    pinnedKeys: tls.pinnedKeys(),
    sessions: sessionManager.list(),
  };
};

const asSelectorParams = (params: unknown): { selector?: string } => {
  if (params === undefined || params === null) {
    return {};
  }

  if (typeof params !== "object" || Array.isArray(params)) {
    throw new RpcApplicationError("invalid_request", "Params must be an object.");
  }

  const selector = (params as Record<string, unknown>).selector;

  if (selector !== undefined && typeof selector !== "string") {
    throw new RpcApplicationError("invalid_request", '"selector" must be a string.');
  }

  return { selector };
};

const asLinkCreateParams = (params: unknown): LinkCreateParams => {
  if (params === undefined || params === null) {
    return {};
  }

  if (typeof params !== "object" || Array.isArray(params)) {
    throw new RpcApplicationError("invalid_request", "Params must be an object.");
  }

  const ttlSeconds = (params as Record<string, unknown>).ttlSeconds;

  if (ttlSeconds !== undefined && (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
    throw new RpcApplicationError("invalid_request", '"ttlSeconds" must be a positive integer.');
  }

  return { ttlSeconds };
};

export const startDaemon = async (options: DaemonOptions): Promise<RunningDaemon> => {
  const clock = options.clock ?? { now: () => new Date() };
  const paths = getStateDirPaths(options.stateDir);

  await ensureStateDir(options.stateDir);

  const config = await loadConfig(paths, { warn: options.warn });
  const startedAt = clock.now();

  let pidfile: PidfileHandle | undefined;
  let server: RpcServer | undefined;
  let listener: DaemonListener | undefined;
  let sessionManager: SessionManager | undefined;
  let eventBus: EventBus | undefined;
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
      // ARCHITECTURE.md §4: close all device sockets (1001) before tearing down the control plane.
      sessionManager?.disposeAll(1001, "daemon_shutdown");
      await listener?.close();
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

    eventBus = createEventBus(clock);
    const activeEventBus = eventBus;
    const detectAddress = (): ReturnType<typeof detectAdvertisedAddress> =>
      detectAdvertisedAddress({ override: config.advertisedIp });

    const tls = await createTlsManager({ keyPath: config.keyPath, detectAddress });

    sessionManager = createSessionManager({
      graceSeconds: config.graceSeconds,
      keepaliveIntervalSeconds: config.keepaliveIntervalSeconds,
      linkTtlSeconds: config.linkTtlSeconds,
      getEndpoint: () => toAgentEndpoint(tls.current().advertisedAddress, config.wssPort),
      eventBus: activeEventBus,
      clock,
    });

    listener = await startListener({
      port: config.wssPort,
      tls,
      sessionManager,
    });

    const activeSessionManager = sessionManager;

    server = await startRpcServer({
      socketPath: getSocketPath(paths),
      dispatch: {
        [RPC_METHODS.daemonStatus]: (): DaemonStatusResult => {
          return buildStatusResult(config, startedAt, tls, activeSessionManager);
        },
        [RPC_METHODS.daemonShutdown]: (_params, context): DaemonShutdownResult => {
          context.afterSend(() => {
            void shutdown();
          });

          return { ok: true };
        },
        [RPC_METHODS.linkCreate]: (params): LinkCreateResult => {
          const { ttlSeconds } = asLinkCreateParams(params);
          return activeSessionManager.createLink(ttlSeconds);
        },
        [RPC_METHODS.sessionsList]: (): SessionsListResult => {
          return activeSessionManager.list();
        },
        [RPC_METHODS.sessionsDescribe]: (params): SessionsDescribeResult => {
          const { selector } = asSelectorParams(params);
          return activeSessionManager.describe(selector);
        },
        [RPC_METHODS.sessionsRevoke]: (params): SessionsRevokeResult => {
          const { selector } = asSelectorParams(params);
          activeSessionManager.revoke(selector);
          return { ok: true };
        },
      },
    });
  } catch (error) {
    // Never leave a half-acquired pidfile/listener/socket behind when startup fails partway through.
    sessionManager?.disposeAll(1001, "daemon_startup_failed");
    await listener?.close();
    await pidfile?.release();
    throw error;
  }

  return {
    paths,
    config,
    startedAt,
    server,
    listener,
    eventBus,
    exited,
    shutdown,
  };
};
