/**
 * Daemon composition root (ARCHITECTURE.md §4): state dir → config → pidfile → TLS → session
 * engine → listener → RPC server. Implements `daemon.status`/`daemon.shutdown`, the session RPC
 * surface (`link.create`, `sessions.list`, `sessions.describe`, `sessions.revoke`), and the
 * invocation surface (`tools.list`, `tools.call`, `events.subscribe`), and policy + audit
 * (ARCHITECTURE.md §12): every `tools.call` attempt is evaluated against `config.policy` and
 * recorded to the audit log inline in the `tools.call` handler below.
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RPC_METHODS,
  EVENT_KINDS,
  type EventKind,
  type ErrorType,
  type DaemonShutdownResult,
  type DaemonStatusResult,
  type EventsSinceParams,
  type EventsSinceResult,
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
  type ToolsCancelParams,
  type ToolsCancelResult,
  type ToolsListResult,
} from "@cordierite/shared";

import type { Clock } from "../cli/types.js";
import { detectAdvertisedAddress } from "./address.js";
import { argsSha256, createAuditLogger, type AuditLogger } from "./audit.js";
import { createCallsManager, type CallsManager } from "./calls.js";
import { loadConfig, type CordieriteConfig, type ConfigWarnFn } from "./config.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import { startListener, type DaemonListener } from "./listener.js";
import { evaluate as evaluatePolicy } from "./policy.js";
import { acquirePidfile, type PidfileHandle } from "./pidfile.js";
import { RpcApplicationError, startRpcServer, type RpcServer } from "./rpc-server.js";
import { createSessionManager, type SessionManager } from "./sessions.js";
import { ensureStateDir, getSocketPath, getStateDirPaths, type StateDirPaths } from "./state-dir.js";
import { createTlsManager, toAgentEndpoint, type TlsManager } from "./tls.js";

/** Used to validate `events.subscribe`/`events.since`'s `kinds` filter. */
const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>(EVENT_KINDS);

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
  /** Advertised-address detector; defaults to `detectAdvertisedAddress` honoring
   * `config.advertisedIp`. Overridable so tests can simulate a network change between two
   * `link.create` calls without mocking `os.networkInterfaces()` process-wide. */
  detectAddress?: () => ReturnType<typeof detectAdvertisedAddress>;
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
  auditLogger: AuditLogger,
  auditDir: string,
): DaemonStatusResult => {
  return {
    version: packageVersion,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    wssPort: config.wssPort,
    pinnedKeys: tls.pinnedKeys(),
    sessions: sessionManager.list(),
    policy: config.policy,
    audit: { path: auditDir, failedWrites: auditLogger.failedWrites() },
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

  const caller = record.caller;

  if (caller !== undefined && caller !== "cli" && caller !== "mcp" && caller !== "client") {
    throw new RpcApplicationError("invalid_request", '"caller" must be "cli", "mcp", or "client".');
  }

  const consent = record.consent;

  if (consent !== undefined && consent !== "client") {
    throw new RpcApplicationError("invalid_request", '"consent" must be "client".');
  }

  return {
    selector: selector as string | undefined,
    name: record.name,
    args: args as Record<string, unknown>,
    timeoutMs: timeoutMs as number | undefined,
    caller: caller as "cli" | "mcp" | "client" | undefined,
    consent: consent as "client" | undefined,
  };
};

const asToolsCancelParams = (params: unknown): ToolsCancelParams => {
  const record = asRecordParams(params);

  const selector = record.selector;

  if (selector !== undefined && typeof selector !== "string") {
    throw new RpcApplicationError("invalid_request", '"selector" must be a string.');
  }

  if (typeof record.callId !== "string" || record.callId.length === 0) {
    throw new RpcApplicationError("invalid_request", '"callId" must be a non-empty string.');
  }

  const reason = record.reason;

  if (reason !== undefined && typeof reason !== "string") {
    throw new RpcApplicationError("invalid_request", '"reason" must be a string.');
  }

  return {
    selector: selector as string | undefined,
    callId: record.callId,
    reason: reason as string | undefined,
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

const asEventsSinceParams = (params: unknown): EventsSinceParams => {
  const record = asRecordParams(params);

  const selector = record.selector;

  if (selector !== undefined && typeof selector !== "string") {
    throw new RpcApplicationError("invalid_request", '"selector" must be a string.');
  }

  const since = record.since;

  if (since !== undefined && (typeof since !== "number" || !Number.isInteger(since) || since < 0)) {
    throw new RpcApplicationError("invalid_request", '"since" must be a non-negative integer.');
  }

  const kindsRaw = record.kinds;
  let kinds: EventKind[] | undefined;

  if (kindsRaw !== undefined) {
    if (!Array.isArray(kindsRaw) || !kindsRaw.every((kind) => typeof kind === "string" && KNOWN_EVENT_KINDS.has(kind))) {
      throw new RpcApplicationError("invalid_request", '"kinds" must be an array of known event kinds.');
    }

    kinds = kindsRaw as EventKind[];
  }

  const limit = record.limit;

  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
    throw new RpcApplicationError("invalid_request", '"limit" must be a positive integer.');
  }

  return {
    selector: selector as string | undefined,
    since: since as number | undefined,
    kinds,
    limit: limit as number | undefined,
  };
};

const asLinkCreateParams = (params: unknown): LinkCreateParams => {
  if (params === undefined || params === null) {
    return {};
  }

  if (typeof params !== "object" || Array.isArray(params)) {
    throw new RpcApplicationError("invalid_request", "Params must be an object.");
  }

  const record = params as Record<string, unknown>;
  const ttlSeconds = record.ttlSeconds;

  if (ttlSeconds !== undefined && (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
    throw new RpcApplicationError("invalid_request", '"ttlSeconds" must be a positive integer.');
  }

  const addressOverride = record.addressOverride;

  if (addressOverride !== undefined && (typeof addressOverride !== "string" || addressOverride.length === 0)) {
    throw new RpcApplicationError("invalid_request", '"addressOverride" must be a non-empty string.');
  }

  return { ttlSeconds, addressOverride: addressOverride as string | undefined };
};

export const startDaemon = async (options: DaemonOptions): Promise<RunningDaemon> => {
  const clock = options.clock ?? { now: () => new Date() };
  const paths = getStateDirPaths(options.stateDir);

  await ensureStateDir(options.stateDir);

  const config = await loadConfig(paths, { warn: options.warn });
  const startedAt = clock.now();
  // Created eagerly (before anything else can fail) so shutdown can always flush it, and so a
  // startup failure before the RPC server exists still gets a chance to record what happened.
  const auditLogger = createAuditLogger({ auditDir: paths.auditDir, clock });

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
      // Flush the audit queue last: nothing else here writes audit records, but this makes sure a
      // record enqueued by the very last `tools.call` before shutdown actually lands on disk.
      await auditLogger.flush();
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

    eventBus = createEventBus({ clock, bufferSize: config.eventBufferSize });
    const activeEventBus = eventBus;
    const detectAddress =
      options.detectAddress ??
      ((): ReturnType<typeof detectAdvertisedAddress> => detectAdvertisedAddress({ override: config.advertisedIp }));

    const tls = await createTlsManager({ keyPath: config.keyPath, detectAddress, warn: options.warn });

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
      sendCancel: (sessionId, message) => activeSessionManager.sendToolCancel(sessionId, message),
      eventBus: activeEventBus,
    });

    const activeCallsManager = callsManager;

    listener = await startListener({
      port: config.wssPort,
      tls,
      sessionManager,
    });

    const activeListener = listener;

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
          return buildStatusResult(config, startedAt, tls, activeSessionManager, auditLogger, paths.auditDir);
        },
        [RPC_METHODS.daemonShutdown]: (_params, context): DaemonShutdownResult => {
          context.afterSend(() => {
            void shutdown();
          });

          return { ok: true };
        },
        [RPC_METHODS.linkCreate]: async (params): Promise<LinkCreateResult> => {
          const { ttlSeconds, addressOverride } = asLinkCreateParams(params);

          // Re-detect the advertised address on every mint (ARCHITECTURE.md §4/§8): a long-lived
          // daemon that changed networks must not keep minting links with a stale address/SAN.
          // `refresh` only re-mints the certificate when the address actually changed; applying the
          // (possibly unchanged) secure context is a cheap no-op the rest of the time, but comparing
          // material identity avoids even that when nothing changed.
          const previousMaterial = tls.current();
          const nextMaterial = await tls.refresh();

          if (nextMaterial !== previousMaterial) {
            activeListener.applyTls(nextMaterial);
          }

          // `tls.refresh()` just ran above, so `pinnedKeys()[0]` reflects the material this link's
          // endpoint will actually serve (opt-in hardening dev-mode: the CLI composes this into the
          // deep link's `pin` query param — see `LinkCreateResult.pin`).
          return { ...activeSessionManager.createLink(ttlSeconds, addressOverride), pin: tls.pinnedKeys()[0]! };
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
          const resolved = activeSessionManager.resolveForTools(selector);

          // Each entry carries its effective policy decision (ARCHITECTURE.md §12) so the MCP
          // server can emit `_meta["anthropic/requiresUserInteraction"]` for "prompt" tools
          // without a second round trip (issue #14).
          return resolved.registry.list().map((descriptor) => ({
            ...descriptor,
            policy: evaluatePolicy(descriptor, { alias: resolved.alias }, config.policy),
          }));
        },
        // This handler is the single seam every `tools.call` passes through: policy (ARCHITECTURE.md
        // §12) is evaluated once the target tool descriptor is known, and one audit record is
        // written for every attempt that reaches a resolved session, across ok/error/denied.
        [RPC_METHODS.toolsCall]: async (params, context): Promise<ToolsCallResult> => {
          const { selector, name, args, timeoutMs, caller, consent } = asToolsCallParams(params);
          const effectiveCaller = caller ?? "cli";
          const resolved = activeSessionManager.resolveForTools(selector);
          const auditStartedAt = clock.now().getTime();

          const writeAudit = (
            outcome: "ok" | "error" | "denied" | "cancelled",
            errorType?: ErrorType,
            grantedConsent?: "client",
            deniedReason?: "policy" | "no_consent_channel",
          ): void => {
            auditLogger.record({
              sessionId: resolved.sessionId,
              alias: resolved.alias,
              tool: name,
              argsSha256: argsSha256(args),
              outcome,
              errorType,
              deniedReason,
              durationMs: clock.now().getTime() - auditStartedAt,
              caller: effectiveCaller,
              consent: grantedConsent,
            });
          };

          if (resolved.state !== "active") {
            const errorType = resolved.state === "suspended" ? "session_suspended" : "session_not_active";
            writeAudit("error", errorType);
            throw new RpcApplicationError(errorType, `Session "${resolved.alias}" is not active.`);
          }

          const tool = resolved.registry.get(name);

          if (!tool) {
            // Deliberately no frame is sent to the app for an unknown tool.
            writeAudit("error", "tool_not_found");
            throw new RpcApplicationError("tool_not_found", `Tool "${name}" is not registered.`);
          }

          const policyDecision = evaluatePolicy(tool, { alias: resolved.alias }, config.policy);
          // "prompt" fails closed (ARCHITECTURE.md §12 / issue #14): it proceeds only when the
          // caller carried `consent: "client"`. This is trusted verbatim once present — the daemon
          // does not and cannot re-derive whether an MCP client's `_meta` was actually honored, the
          // same way it doesn't re-verify any other RPC param. `consent` is only ever justified
          // when set by this codebase's own MCP server (mcp/server.ts), which sets it solely after
          // confirming both that it emitted `_meta["anthropic/requiresUserInteraction"]` for this
          // exact tool on this connection's most recent listing, and that the connected client is
          // known to enforce it. Any other local process with access to `daemon.sock` — including
          // the CLI, or an agent with shell access, which is the typical setup this feature targets
          // — could send `consent: "client"` directly; that is not a bypass of this feature so much
          // as a restatement of this codebase's existing trust boundary (docs/SECURITY.md: anything
          // that can reach the socket already has full daemon control). "prompt" guards against a
          // compliant MCP client silently auto-approving on the caller's behalf, not against a
          // hostile process on the operator's own machine.
          const grantedConsent: "client" | undefined =
            policyDecision === "prompt" && consent === "client" ? "client" : undefined;

          if (policyDecision === "deny" || (policyDecision === "prompt" && grantedConsent === undefined)) {
            // Denied → no frame reaches the app, and the call never starts.
            activeEventBus.emit({
              kind: "tool_call_finished",
              sessionId: resolved.sessionId,
              alias: resolved.alias,
              data: { name, outcome: "denied" },
            });

            if (policyDecision === "prompt") {
              writeAudit("denied", undefined, undefined, "no_consent_channel");

              throw new RpcApplicationError(
                "policy_denied",
                `Policy requires prompt consent to call "${name}" on session "${resolved.alias}", but no consent channel confirmed it.`,
                -32000,
                {
                  reason: "no_consent_channel",
                  hint: `This caller did not confirm human consent for "${name}". Claude Code ≥ v2.1.199 confirms it automatically over MCP; every other caller (including the CLI) is denied by design until another consent channel is implemented. To change this tool's policy, edit "policy.tools[\"${resolved.alias}/${name}\"]" (or policy.default/policy.destructive) in ${paths.configPath}.`,
                },
              );
            }

            writeAudit("denied", undefined, undefined, "policy");

            throw new RpcApplicationError(
              "policy_denied",
              `Policy denies calling "${name}" on session "${resolved.alias}".`,
              -32000,
              { hint: `Edit "policy" in ${paths.configPath} (policy.default/policy.destructive/policy.tools) to change this.` },
            );
          }

          const startedAt = clock.now().getTime();
          const session = { sessionId: resolved.sessionId, alias: resolved.alias };
          // `callId` is available synchronously (before the app has answered) precisely so it can
          // be exposed to the RPC caller and stamped on every event in this call's lifecycle — the
          // MCP server correlates its own in-flight `tools.call` against `tool_call_progress`
          // notifications by this id, unambiguous under concurrent calls.
          const { callId, result: callResult } = activeCallsManager.call(
            session,
            name,
            args,
            // The caller's explicit `timeoutMs` wins; otherwise the tool's own declared deadline is
            // the default, and only if it declares none does `clampTimeout` fall back to
            // DEFAULT_CALL_TIMEOUT_MS (issue #25).
            timeoutMs ?? tool.timeoutMs,
          );

          // If the connection that issued this tools.call drops while the call is still pending
          // (CLI Ctrl-C, MCP client disconnect), tell the app to stop rather than leaving an
          // orphaned handler running for a caller nobody is waiting on anymore. Unregistered once
          // this call settles either way — otherwise a long-lived connection issuing many calls
          // (e.g. the MCP server's persistent stream) leaks one closure per call for its lifetime.
          const unregisterOnClose = context.onClose(() => {
            activeCallsManager.cancel(resolved.sessionId, callId, "connection_closed");
          });

          activeEventBus.emit({
            kind: "tool_call_started",
            sessionId: resolved.sessionId,
            alias: resolved.alias,
            data: { name, callId },
          });

          try {
            const result = await callResult;

            activeEventBus.emit({
              kind: "tool_call_finished",
              sessionId: resolved.sessionId,
              alias: resolved.alias,
              data: { name, callId, durationMs: clock.now().getTime() - startedAt, outcome: "ok" },
            });
            writeAudit("ok", undefined, grantedConsent);

            return { result, callId };
          } catch (error) {
            const errorType = error instanceof RpcApplicationError ? error.type : "tool_execution_error";
            const outcome = errorType === "tool_cancelled" ? "cancelled" : "error";

            activeEventBus.emit({
              kind: "tool_call_finished",
              sessionId: resolved.sessionId,
              alias: resolved.alias,
              data: { name, callId, durationMs: clock.now().getTime() - startedAt, outcome, errorType },
            });
            writeAudit(outcome, errorType, grantedConsent);

            throw error;
          } finally {
            unregisterOnClose();
          }
        },
        [RPC_METHODS.toolsCancel]: (params): ToolsCancelResult => {
          const { selector, callId, reason } = asToolsCancelParams(params);
          const resolved = activeSessionManager.resolveForTools(selector);
          const cancelled = activeCallsManager.cancel(resolved.sessionId, callId, reason ?? "client_cancelled");

          return { cancelled };
        },
        [RPC_METHODS.eventsSubscribe]: (params, context): EventsSubscribeResult => {
          const { sessionSelector, kinds } = asEventsSubscribeParams(params);

          context.connection.state.eventSubscription = {
            sessionSelector,
            kinds: kinds ? new Set(kinds) : undefined,
          } satisfies EventSubscription;

          return { ok: true };
        },
        [RPC_METHODS.eventsSince]: (params): EventsSinceResult => {
          const { selector, since, kinds, limit } = asEventsSinceParams(params);
          // Resolved the same way as every other selector-taking method (`sessions.describe`,
          // `tools.list`): defaults to the sole active/suspended session, errors on ambiguity, and
          // works for a suspended session too — a suspended app's already-retained events are still
          // fair game to drain.
          const resolved = activeSessionManager.describe(selector);

          return activeEventBus.since(resolved.sessionId, { since, kinds, limit });
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

  // ARCHITECTURE.md §5 lists `daemon_started` among the real event kinds; emitted once startup has
  // fully succeeded (pidfile/TLS/listener/RPC server all up) so a subscriber never sees it followed
  // by a startup failure.
  eventBus.emit({ kind: "daemon_started", data: { version: packageVersion, pid: process.pid } });

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
