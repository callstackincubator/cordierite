/**
 * Daemon composition root (ARCHITECTURE.md §4): state dir → config → pidfile → TLS → session
 * engine → listener → RPC server. Implements `daemon.status`/`daemon.shutdown`, the session RPC
 * surface (`link.create`, `sessions.list`, `sessions.describe`, `sessions.revoke`), and the
 * invocation surface (`tools.list`, `tools.call`, `events.subscribe`; policy/audit land in task
 * 13, which wraps the `tools.call` handler below — that handler is the single seam it hooks).
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RPC_METHODS,
  type EventKind,
  type DaemonShutdownResult,
  type DaemonStatusResult,
  type EventsSubscribeParams,
  type EventsSubscribeResult,
  type LinkCreateParams,
  type LinkCreateResult,
  type SessionsDescribeResult,
  type SessionsListResult,
  type SessionsRevokeResult,
  type ToolResultMessage,
  type ToolErrorMessage,
  type ToolCallProgressMessage,
  type ToolsCallParams,
  type ToolsCallResult,
  type ToolsListResult,
} from "@cordierite/shared";

import type { Clock } from "../cli/types.js";
import { detectAdvertisedAddress } from "./address.js";
import { createCallsManager, type CallsManager } from "./calls.js";
import { loadConfig, type CordieriteConfig, type ConfigWarnFn } from "./config.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import { startListener, type DaemonListener } from "./listener.js";
import { acquirePidfile, type PidfileHandle } from "./pidfile.js";
import { RpcApplicationError, startRpcServer, type RpcServer } from "./rpc-server.js";
import { createSessionManager, type SessionManager } from "./sessions.js";
import { ensureStateDir, getSocketPath, getStateDirPaths, type StateDirPaths } from "./state-dir.js";
import { createTlsManager, toAgentEndpoint, type TlsManager } from "./tls.js";

/** Runtime mirror of the shared `EventKind` union (ARCHITECTURE.md §5), used to validate
 * `events.subscribe`'s `kinds` filter — the shared package only exports the type. */
const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>([
  "daemon_started",
  "link_created",
  "session_claimed",
  "session_suspended",
  "session_resumed",
  "session_revoked",
  "session_expired",
  "tools_changed",
  "app_event",
  "tool_call_started",
  "tool_call_finished",
]);

/** Per-connection `events.subscribe` state, stashed in `RpcConnection.state`. */
type EventSubscription = {
  sessionSelector?: string;
  kinds?: ReadonlySet<EventKind>;
};

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

const asRecordParams = (params: unknown): Record<string, unknown> => {
  if (params === undefined || params === null) {
    return {};
  }

  if (typeof params !== "object" || Array.isArray(params)) {
    throw new RpcApplicationError("invalid_request", "Params must be an object.");
  }

  return params as Record<string, unknown>;
};

const asToolsCallParams = (params: unknown): ToolsCallParams => {
  const record = asRecordParams(params);

  const selector = record.selector;

  if (selector !== undefined && typeof selector !== "string") {
    throw new RpcApplicationError("invalid_request", '"selector" must be a string.');
  }

  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new RpcApplicationError("invalid_request", '"name" must be a non-empty string.');
  }

  const args = record.args;

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new RpcApplicationError("invalid_request", '"args" must be a JSON object.');
  }

  const timeoutMs = record.timeoutMs;

  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))) {
    throw new RpcApplicationError("invalid_request", '"timeoutMs" must be a number.');
  }

  return {
    selector: selector as string | undefined,
    name: record.name,
    args: args as Record<string, unknown>,
    timeoutMs: timeoutMs as number | undefined,
  };
};

const asEventsSubscribeParams = (params: unknown): EventsSubscribeParams => {
  const record = asRecordParams(params);

  const sessionSelector = record.sessionSelector;

  if (sessionSelector !== undefined && typeof sessionSelector !== "string") {
    throw new RpcApplicationError("invalid_request", '"sessionSelector" must be a string.');
  }

  const kindsRaw = record.kinds;
  let kinds: EventKind[] | undefined;

  if (kindsRaw !== undefined) {
    if (!Array.isArray(kindsRaw) || !kindsRaw.every((kind) => typeof kind === "string" && KNOWN_EVENT_KINDS.has(kind))) {
      throw new RpcApplicationError("invalid_request", '"kinds" must be an array of known event kinds.');
    }

    kinds = kindsRaw as EventKind[];
  }

  return { sessionSelector: sessionSelector as string | undefined, kinds };
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
  let callsManager: CallsManager | undefined;
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
      // Reject any calls still in flight before the sockets that would have answered them go away.
      callsManager?.disposeAll();
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
      onToolFrame: (message) => {
        switch (message.type) {
          case "tool_result":
            callsManager?.handleToolResult(message as ToolResultMessage);
            return;
          case "tool_error":
            callsManager?.handleToolError(message as ToolErrorMessage);
            return;
          case "tool_call_progress":
            callsManager?.handleToolCallProgress(message as ToolCallProgressMessage);
        }
      },
      onAppEvent: (sessionId, alias, message) => {
        activeEventBus.emit({
          kind: "app_event",
          sessionId,
          alias,
          data: { name: message.name, payload: message.payload, ts: message.ts },
        });
      },
    });

    const activeSessionManager = sessionManager;

    callsManager = createCallsManager({
      send: (sessionId, message) => activeSessionManager.sendToolCall(sessionId, message),
      eventBus: activeEventBus,
    });

    const activeCallsManager = callsManager;

    listener = await startListener({
      port: config.wssPort,
      tls,
      sessionManager,
    });

    // `events.subscribe` fan-out: one global listener pushes matching notifications to every RPC
    // connection currently marked as a subscriber (state stashed by the `events.subscribe` handler
    // below). `RpcServer.notify` itself guards against a slow/dead subscriber backing up the daemon.
    activeEventBus.subscribe((event) => {
      for (const connection of server?.connections() ?? []) {
        const subscription = connection.state.eventSubscription as EventSubscription | undefined;

        if (!subscription) {
          continue;
        }

        if (subscription.kinds && !subscription.kinds.has(event.kind)) {
          continue;
        }

        if (
          subscription.sessionSelector !== undefined &&
          event.sessionId !== subscription.sessionSelector &&
          event.alias !== subscription.sessionSelector
        ) {
          continue;
        }

        server?.notify(connection, event);
      }
    });

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
        [RPC_METHODS.toolsList]: (params): ToolsListResult => {
          const { selector } = asSelectorParams(params);
          // ARCHITECTURE.md §5: tools.list works for ACTIVE and SUSPENDED sessions alike (the
          // retained registry survives suspend); only tools.call requires ACTIVE.
          return activeSessionManager.resolveForTools(selector).registry.list();
        },
        // This handler is the single seam every `tools.call` passes through — task 13 inserts
        // policy checks and audit records here, wrapping (not duplicating) this logic.
        [RPC_METHODS.toolsCall]: async (params): Promise<ToolsCallResult> => {
          const { selector, name, args, timeoutMs } = asToolsCallParams(params);
          const resolved = activeSessionManager.resolveForTools(selector);

          if (resolved.state !== "active") {
            throw new RpcApplicationError(
              resolved.state === "suspended" ? "session_suspended" : "session_not_active",
              `Session "${resolved.alias}" is not active.`,
            );
          }

          const tool = resolved.registry.get(name);

          if (!tool) {
            // Deliberately no frame is sent to the app for an unknown tool (task 05 scope item 3).
            throw new RpcApplicationError("tool_not_found", `Tool "${name}" is not registered.`);
          }

          const startedAt = clock.now().getTime();
          const session = { sessionId: resolved.sessionId, alias: resolved.alias };

          activeEventBus.emit({
            kind: "tool_call_started",
            sessionId: resolved.sessionId,
            alias: resolved.alias,
            data: { name },
          });

          try {
            const result = await activeCallsManager.call(session, name, args, timeoutMs);

            activeEventBus.emit({
              kind: "tool_call_finished",
              sessionId: resolved.sessionId,
              alias: resolved.alias,
              data: { name, durationMs: clock.now().getTime() - startedAt, outcome: "ok" },
            });

            return { result };
          } catch (error) {
            const errorType = error instanceof RpcApplicationError ? error.type : "tool_execution_error";

            activeEventBus.emit({
              kind: "tool_call_finished",
              sessionId: resolved.sessionId,
              alias: resolved.alias,
              data: { name, durationMs: clock.now().getTime() - startedAt, outcome: "error", errorType },
            });

            throw error;
          }
        },
        [RPC_METHODS.eventsSubscribe]: (params, context): EventsSubscribeResult => {
          const { sessionSelector, kinds } = asEventsSubscribeParams(params);

          context.connection.state.eventSubscription = {
            sessionSelector,
            kinds: kinds ? new Set(kinds) : undefined,
          } satisfies EventSubscription;

          return { ok: true };
        },
      },
    });
  } catch (error) {
    // Never leave a half-acquired pidfile/listener/socket behind when startup fails partway through.
    callsManager?.disposeAll();
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
