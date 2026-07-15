/**
 * The session state machine (ARCHITECTURE.md §6, exactly): PENDING (owned by links.ts) →
 * ACTIVE ⇄ SUSPENDED → EXPIRED, with REVOKED reachable from any live state. This module owns the
 * live-session map, claim/resume handling (including the pre-auth hardening in the task's
 * rejection matrix), alias assignment, keepalive-driven suspend, and grace-timer expiry.
 *
 * Pending links never enter `sessions` — they live in links.ts's `PendingLinkRegistry` and are
 * only ever resolved during claim. `sessions` therefore only ever holds live (active/suspended)
 * sessions; terminal transitions (revoked/expired) remove the entry immediately (ARCHITECTURE.md
 * §6: "terminal states free the alias" — there is no persisted history, matching §3/§13's "no
 * per-session files, all state in-daemon-memory").
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  isEventMessage,
  isToolCallProgressMessage,
  isToolErrorMessage,
  isToolRegistryDeltaMessage,
  isToolRegistrySnapshotMessage,
  isToolResultMessage,
  parseSessionClaimDeviceFields,
  type EventKind,
  type EventMessage,
  type SessionAckMessage,
  type SessionClaimMessage,
  type SessionDeviceMetadata,
  type SessionResumeMessage,
  type SessionSummary,
  type ToolCallMessage,
  type ToolCallProgressMessage,
  type ToolErrorMessage,
  type ToolResultMessage,
} from "@cordierite/shared";
import type { WebSocket } from "ws";

import type { Clock } from "../cli/types.js";
import type { EventBus } from "./event-bus.js";
import { createPendingLinkRegistry, type CreatedLink, type PendingLinkRegistry } from "./links.js";
import { RpcApplicationError } from "./rpc-server.js";
import { createToolRegistry, type ToolRegistry } from "./registry.js";
import { systemTimers, type TimerFns, type TimerHandle } from "./timers.js";

const RESUME_TOKEN_BYTES = 32;

/** Wire message types allowed *after* claim (session_claim/session_resume are pre-claim only). */
export const POST_CLAIM_MESSAGE_TYPES = new Set<string>([
  "tool_registry_snapshot",
  "tool_registry_delta",
  "tool_result",
  "tool_error",
  "tool_call_progress",
  "event",
]);

export const isPostClaimMessageType = (type: unknown): type is string => {
  return typeof type === "string" && POST_CLAIM_MESSAGE_TYPES.has(type);
};

export const slugifyDeviceModel = (model?: string): string => {
  if (!model) {
    return "device";
  }

  const slug = model
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

  return slug.length > 0 ? slug : "device";
};

export const dedupeAlias = (base: string, existingAliases: ReadonlySet<string>): string => {
  if (!existingAliases.has(base)) {
    return base;
  }

  let suffix = 2;

  while (existingAliases.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  return `${base}-${suffix}`;
};

type LiveSession = {
  sessionId: string;
  alias: string;
  state: "active" | "suspended";
  device: SessionDeviceMetadata;
  createdAt: Date;
  claimedAt: Date;
  suspendedAt?: Date;
  resumeToken: Buffer;
  socket?: WebSocket;
  missedPongs: number;
  registry: ToolRegistry;
  graceTimer?: TimerHandle;
};

const decodeFixedLengthToken = (base64url: string, expectedLength: number): Buffer | null => {
  let decoded: Buffer;

  try {
    decoded = Buffer.from(base64url, "base64url");
  } catch {
    return null;
  }

  return decoded.length === expectedLength ? decoded : null;
};

/** Constant-time-safe comparison: never calls `timingSafeEqual` on mismatched lengths (it throws). */
const tokensMatch = (candidate: Buffer | null, expected: Buffer): boolean => {
  if (!candidate || candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(candidate, expected);
};

const MAX_FAILED_CLAIM_ATTEMPTS = 5;

const closeSocket = (socket: WebSocket, code: number, reason: string): void => {
  try {
    socket.close(code, reason);
  } catch {
    // The socket may already be closing/closed; never let a double-close crash the daemon.
    socket.terminate();
  }
};

export type SessionManagerOptions = {
  graceSeconds: number;
  keepaliveIntervalSeconds: number;
  linkTtlSeconds: number;
  getEndpoint: () => CreatedLink["endpoint"];
  eventBus: EventBus;
  clock?: Clock;
  timers?: TimerFns;
  /** Routes a validated `tool_result`/`tool_error`/`tool_call_progress` frame (task 05's
   * `calls.ts` correlates it); wired by the composition root once both modules exist. */
  onToolFrame?: (message: ToolResultMessage | ToolErrorMessage | ToolCallProgressMessage) => void;
  /** Routes a validated app-side `event` frame; the composition root forwards it to the event bus
   * as `app_event` (ARCHITECTURE.md §7/task 05 scope item 5). */
  onAppEvent?: (sessionId: string, alias: string, message: EventMessage) => void;
};

export type LinkCreateResult = {
  sessionId: string;
  deepLinkPayload: string;
  endpoint: CreatedLink["endpoint"];
  expiresAt: number;
};

export type SessionManager = {
  createLink: (ttlSeconds?: number) => LinkCreateResult;
  /** First message on a fresh socket. Returns the claimed sessionId, or `null` after closing the socket. */
  handleClaim: (socket: WebSocket, message: SessionClaimMessage) => string | null;
  /** First message on a resume socket. Returns the resumed sessionId, or `null` after closing the socket. */
  handleResume: (socket: WebSocket, message: SessionResumeMessage) => string | null;
  /** Dispatches an already-type-checked post-claim message; closes the socket on invalid content. */
  handlePostClaimMessage: (sessionId: string, socket: WebSocket, message: Record<string, unknown>) => void;
  list: () => SessionSummary[];
  describe: (selector?: string) => SessionSummary;
  revoke: (selector?: string) => void;
  /** Resolves a selector for the `tools.*` RPC surface (task 05): same selector rules as
   * `describe`/`revoke` (no_session/ambiguous_session/unknown_session), but returns the pieces
   * `tools.list`/`tools.call` need directly rather than a wire-shaped summary. */
  resolveForTools: (selector?: string) => {
    sessionId: string;
    alias: string;
    state: "active" | "suspended";
    registry: ToolRegistry;
  };
  /** Sends a `tool_call` frame to the session's active socket; `false` if the session has no
   * active socket right now (caller has typically already checked ACTIVE state via
   * {@link resolveForTools}, but the socket can still disappear between check and send). */
  sendToolCall: (sessionId: string, message: ToolCallMessage) => boolean;
  /** Closes every live socket with the given code (daemon shutdown) and clears all timers. */
  disposeAll: (code: number, reason: string) => void;
};

export const createSessionManager = (options: SessionManagerOptions): SessionManager => {
  const clock = options.clock ?? { now: () => new Date() };
  const timers = options.timers ?? systemTimers;
  const sessions = new Map<string, LiveSession>();

  const pendingLinks: PendingLinkRegistry = createPendingLinkRegistry({
    getEndpoint: options.getEndpoint,
    clock,
    timers,
    eventBus: options.eventBus,
  });

  const emit = (kind: EventKind, sessionId: string | undefined, alias: string | undefined, data: unknown): void => {
    options.eventBus.emit({ kind, sessionId, alias, data });
  };

  const toSummary = (session: LiveSession): SessionSummary => {
    return {
      sessionId: session.sessionId,
      alias: session.alias,
      state: session.state,
      device: session.device,
      createdAt: session.createdAt.toISOString(),
      claimedAt: session.claimedAt.toISOString(),
      ...(session.suspendedAt ? { suspendedAt: session.suspendedAt.toISOString() } : {}),
      toolCount: session.registry.count(),
    };
  };

  const resolveSession = (selector?: string): LiveSession => {
    const live = Array.from(sessions.values());

    if (selector !== undefined) {
      const match = live.find((session) => session.sessionId === selector || session.alias === selector);

      if (!match) {
        throw new RpcApplicationError("unknown_session", `No session matches "${selector}".`);
      }

      return match;
    }

    if (live.length === 0) {
      throw new RpcApplicationError("no_session", "No active or suspended session, and none was specified.");
    }

    if (live.length > 1) {
      throw new RpcApplicationError(
        "ambiguous_session",
        `Multiple sessions are live (${live.map((session) => session.alias).join(", ")}); specify a selector.`,
      );
    }

    return live[0]!;
  };

  const assignAlias = (model: string | undefined): string => {
    const base = slugifyDeviceModel(model);
    const existing = new Set(Array.from(sessions.values(), (session) => session.alias));
    return dedupeAlias(base, existing);
  };

  const sendAck = (socket: WebSocket, session: LiveSession): void => {
    const ack: SessionAckMessage = {
      type: "session_ack",
      session_id: session.sessionId,
      status: "ok",
      alias: session.alias,
      resume_token: session.resumeToken.toString("base64url"),
      keepalive_interval_s: options.keepaliveIntervalSeconds,
      grace_s: options.graceSeconds,
    };

    socket.send(JSON.stringify(ack), (error) => {
      if (error) {
        // The 'close'/'error' listeners (attached below) own recovery; a failed send must never
        // throw into the socket library's event loop turn (v1's exact defect).
        closeSocket(socket, 1011, "send_failed");
      }
    });
  };

  const suspend = (sessionId: string): void => {
    const session = sessions.get(sessionId);

    if (!session || session.state !== "active") {
      return;
    }

    session.state = "suspended";
    session.suspendedAt = clock.now();
    session.socket = undefined;
    session.missedPongs = 0;
    session.graceTimer = timers.setTimeout(() => expire(sessionId), options.graceSeconds * 1000);

    emit("session_suspended", session.sessionId, session.alias, {});
  };

  const expire = (sessionId: string): void => {
    const session = sessions.get(sessionId);

    if (!session || session.state !== "suspended") {
      return;
    }

    sessions.delete(sessionId);
    emit("session_expired", session.sessionId, session.alias, {});
  };

  const attachSocketHandlers = (session: LiveSession): void => {
    const socket = session.socket!;

    socket.on("error", () => {
      // Never let an unhandled 'error' crash the daemon (v1's fatal defect) — 'close' still fires
      // after 'error' and drives the suspend transition.
    });

    socket.on("pong", () => {
      session.missedPongs = 0;
    });

    socket.on("close", () => {
      if (session.socket === socket) {
        suspend(session.sessionId);
      }
    });
  };

  // Server-side keepalive (ARCHITECTURE.md §7): ping every `keepaliveIntervalSeconds`; two missed
  // pongs in a row is treated as socket loss and suspends the session (never crashes the daemon).
  const keepaliveInterval = timers.setInterval(() => {
    for (const session of sessions.values()) {
      if (session.state !== "active" || !session.socket) {
        continue;
      }

      if (session.missedPongs >= 2) {
        const staleSocket = session.socket;
        session.socket = undefined;
        suspend(session.sessionId);
        staleSocket.terminate();
        continue;
      }

      session.missedPongs += 1;

      try {
        session.socket.ping();
      } catch {
        // A ping failure is surfaced via the socket's own 'error'/'close' handlers.
      }
    }
  }, options.keepaliveIntervalSeconds * 1000);

  const createLink = (ttlSeconds?: number): LinkCreateResult => {
    const { link, deepLinkPayload, endpoint } = pendingLinks.create(ttlSeconds ?? options.linkTtlSeconds);

    return {
      sessionId: link.sessionId,
      deepLinkPayload,
      endpoint,
      expiresAt: Math.floor(link.expiresAt.getTime() / 1000),
    };
  };

  const handleClaim = (socket: WebSocket, message: SessionClaimMessage): string | null => {
    const pending = pendingLinks.get(message.session_id);

    if (!pending) {
      if (sessions.has(message.session_id)) {
        closeSocket(socket, 1008, "already_claimed");
      } else {
        closeSocket(socket, 1008, "unknown_session");
      }

      return null;
    }

    const nowMs = clock.now().getTime();

    if (pending.expiresAt.getTime() <= nowMs) {
      pendingLinks.discard(pending.sessionId);
      closeSocket(socket, 1008, "link_expired");
      return null;
    }

    const candidateToken = decodeFixedLengthToken(message.token, pending.token.length);

    if (!tokensMatch(candidateToken, pending.token)) {
      // Up to MAX_FAILED_CLAIM_ATTEMPTS failures are tolerated (the link stays claimable); the
      // *next* one (the "6th claim attempt" in the acceptance matrix) invalidates it.
      const attempts = pendingLinks.recordFailedAttempt(pending.sessionId);

      if (attempts > MAX_FAILED_CLAIM_ATTEMPTS) {
        pendingLinks.discard(pending.sessionId);
        closeSocket(socket, 1008, "claim_attempts_exceeded");
      } else {
        closeSocket(socket, 1008, "invalid_token");
      }

      return null;
    }

    pendingLinks.consume(pending.sessionId);

    const deviceFields = parseSessionClaimDeviceFields(message as unknown as Record<string, unknown>);
    const device: SessionDeviceMetadata = deviceFields && deviceFields !== "invalid" ? deviceFields : {};
    const alias = assignAlias(device.model);
    const sessionId = pending.sessionId;

    const session: LiveSession = {
      sessionId,
      alias,
      state: "active",
      device,
      createdAt: pending.createdAt,
      claimedAt: clock.now(),
      resumeToken: randomBytes(RESUME_TOKEN_BYTES),
      socket,
      missedPongs: 0,
      registry: createToolRegistry(() => {
        emit("tools_changed", sessionId, alias, { toolCount: session.registry.count() });
      }),
    };

    sessions.set(sessionId, session);
    attachSocketHandlers(session);
    sendAck(socket, session);
    emit("session_claimed", sessionId, alias, { device });

    return sessionId;
  };

  const handleResume = (socket: WebSocket, message: SessionResumeMessage): string | null => {
    const session = sessions.get(message.session_id);

    if (!session) {
      closeSocket(socket, 1008, "unknown_session");
      return null;
    }

    const candidateToken = decodeFixedLengthToken(message.resume_token, session.resumeToken.length);

    if (!tokensMatch(candidateToken, session.resumeToken)) {
      closeSocket(socket, 1008, "invalid_resume_token");
      return null;
    }

    // Resuming an ACTIVE session is a socket replacement (e.g. app reconnected before the old
    // socket's close event was observed) rather than an error: adopt the new socket, drop the old.
    if (session.state === "active" && session.socket && session.socket !== socket) {
      const staleSocket = session.socket;
      session.socket = undefined; // prevents the stale socket's 'close' handler from suspending us
      closeSocket(staleSocket, 1000, "session_replaced");
    }

    if (session.graceTimer) {
      timers.clearTimeout(session.graceTimer);
      session.graceTimer = undefined;
    }

    session.resumeToken = randomBytes(RESUME_TOKEN_BYTES);
    session.state = "active";
    session.suspendedAt = undefined;
    session.socket = socket;
    session.missedPongs = 0;

    attachSocketHandlers(session);
    sendAck(socket, session);
    emit("session_resumed", session.sessionId, session.alias, {});

    return session.sessionId;
  };

  const handlePostClaimMessage = (
    sessionId: string,
    socket: WebSocket,
    message: Record<string, unknown>,
  ): void => {
    const session = sessions.get(sessionId);

    if (!session) {
      closeSocket(socket, 1008, "unknown_session");
      return;
    }

    switch (message.type) {
      case "tool_registry_snapshot": {
        if (!isToolRegistrySnapshotMessage(message)) {
          closeSocket(socket, 1008, "invalid_registry");
          return;
        }

        session.registry.snapshot(message.tools);
        return;
      }

      case "tool_registry_delta": {
        if (!isToolRegistryDeltaMessage(message)) {
          closeSocket(socket, 1008, "invalid_registry");
          return;
        }

        if (message.operation === "upsert") {
          session.registry.upsert(message.tool);
        } else {
          session.registry.remove(message.name);
        }

        return;
      }

      case "tool_result": {
        if (!isToolResultMessage(message)) {
          closeSocket(socket, 1008, "invalid_message");
          return;
        }

        options.onToolFrame?.(message);
        return;
      }

      case "tool_error": {
        if (!isToolErrorMessage(message)) {
          closeSocket(socket, 1008, "invalid_message");
          return;
        }

        options.onToolFrame?.(message);
        return;
      }

      case "tool_call_progress": {
        if (!isToolCallProgressMessage(message)) {
          closeSocket(socket, 1008, "invalid_message");
          return;
        }

        options.onToolFrame?.(message);
        return;
      }

      case "event": {
        if (!isEventMessage(message)) {
          closeSocket(socket, 1008, "invalid_message");
          return;
        }

        options.onAppEvent?.(sessionId, session.alias, message);
        return;
      }

      default:
        closeSocket(socket, 1008, "unknown_message_type");
    }
  };

  const revoke = (selector?: string): void => {
    // sessions.revoke is reachable from any state (ARCHITECTURE.md §6), including an unclaimed
    // pending link — but only when explicitly selected by sessionId (pending links have no alias
    // and are never eligible for the "exactly one live session" implicit-selector default).
    if (selector !== undefined && !sessions.has(selector) && pendingLinks.get(selector)) {
      pendingLinks.discard(selector);
      emit("session_revoked", selector, undefined, {});
      return;
    }

    const session = resolveSession(selector);

    if (session.graceTimer) {
      timers.clearTimeout(session.graceTimer);
    }

    if (session.socket) {
      closeSocket(session.socket, 1000, "revoked");
    }

    sessions.delete(session.sessionId);
    emit("session_revoked", session.sessionId, session.alias, {});
  };

  const disposeAll = (code: number, reason: string): void => {
    timers.clearInterval(keepaliveInterval);
    pendingLinks.disposeAll();

    for (const session of sessions.values()) {
      if (session.graceTimer) {
        timers.clearTimeout(session.graceTimer);
      }

      if (session.socket) {
        closeSocket(session.socket, code, reason);
      }
    }

    sessions.clear();
  };

  const resolveForTools = (
    selector?: string,
  ): { sessionId: string; alias: string; state: "active" | "suspended"; registry: ToolRegistry } => {
    const session = resolveSession(selector);
    return { sessionId: session.sessionId, alias: session.alias, state: session.state, registry: session.registry };
  };

  const sendToolCall = (sessionId: string, message: ToolCallMessage): boolean => {
    const session = sessions.get(sessionId);

    if (!session || session.state !== "active" || !session.socket) {
      return false;
    }

    const socket = session.socket;

    socket.send(JSON.stringify(message), (error) => {
      if (error) {
        // A failed send must never throw into the socket library's event loop turn (v1's exact
        // defect); the resulting 'close'/'error' drives suspend, which rejects the pending call.
        closeSocket(socket, 1011, "send_failed");
      }
    });

    return true;
  };

  return {
    createLink,
    handleClaim,
    handleResume,
    handlePostClaimMessage,
    list: () => Array.from(sessions.values(), toSummary),
    describe: (selector) => toSummary(resolveSession(selector)),
    revoke,
    resolveForTools,
    sendToolCall,
    disposeAll,
  };
};
