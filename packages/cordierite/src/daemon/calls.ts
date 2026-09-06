/**
 * Per-session tool-invocation manager (ARCHITECTURE.md §5 `tools.call`, §7 `tool_call` /
 * `tool_result` / `tool_error` / `tool_call_progress`). This is the v2 replacement for v1's
 * `pendingCalls` map: the correlation pattern (`call_<random>` ids, resolve on `tool_result`,
 * reject on `tool_error`) was sound and is kept. v1's defect was error flattening — the app's
 * `error.type` got re-wrapped twice and ended up buried two `details` levels deep. Here the type is
 * preserved verbatim: {@link RpcApplicationError.type} is set directly from the app's
 * `tool_error.error.type`, never a generic wrapper.
 *
 * This module knows nothing about sockets or the session state machine — `sessions.ts` (via the
 * composition root in `daemon.ts`) supplies a `send` function and routes incoming
 * `tool_result`/`tool_error`/`tool_call_progress` frames and suspend/revoke/expiry transitions back
 * in. That keeps a single seam (`call`) that a policy layer can wrap.
 */

import { randomBytes } from "node:crypto";

import {
  clampToolTimeoutMs,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
  type ToolCallMessage,
  type ToolCallProgressMessage,
  type ToolCancelMessage,
  type ToolErrorMessage,
  type ToolResultMessage,
} from "@cordierite/shared";

import type { EventBus } from "./event-bus.js";
import { RpcApplicationError } from "./rpc-server.js";
import { systemTimers, type TimerFns, type TimerHandle } from "./timers.js";

/** Re-exported under this module's historical names; the values live in `@cordierite/shared` so the
 * RN SDK's app-side abort timer and this timer cannot drift apart (issue #25). */
export const DEFAULT_CALL_TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS;
export const MIN_CALL_TIMEOUT_MS = MIN_TOOL_TIMEOUT_MS;
export const MAX_CALL_TIMEOUT_MS = MAX_TOOL_TIMEOUT_MS;

/** Identifies the session a call belongs to; carried through so progress/lifecycle events can be
 * tagged with the alias without this module needing to look sessions back up. */
export type CallSession = {
  sessionId: string;
  alias: string;
};

/** Sends a `tool_call` frame to the session's active socket; `false` if there is none (the caller
 * must already have checked the session is ACTIVE, but the socket can still vanish mid-flight —
 * the resulting rejection comes from the `session_suspended` transition below, not this return). */
export type SendToolCall = (sessionId: string, message: ToolCallMessage) => boolean;

/** Sends a `tool_cancel` frame to the session's active socket; `false` if there is none. */
export type SendToolCancel = (sessionId: string, message: ToolCancelMessage) => boolean;

export type CallsManagerOptions = {
  send: SendToolCall;
  sendCancel: SendToolCancel;
  eventBus: EventBus;
  timers?: TimerFns;
};

/** The call id (available synchronously, before the app has answered) plus the eventual result —
 * lets the caller correlate its own `tools.call` with `tool_call_started`/`tool_call_progress`
 * events carrying the same `callId` before it has anything to await. */
export type StartedCall = {
  callId: string;
  result: Promise<unknown>;
};

export type CallsManager = {
  /** Sends `tool_call` with a fresh `call_<random>` id, tracks it in a per-session pending map,
   * resolves on the matching `tool_result`, rejects on `tool_error` (type preserved verbatim) or
   * after `timeoutMs` (clamped to [{@link MIN_CALL_TIMEOUT_MS}, {@link MAX_CALL_TIMEOUT_MS}],
   * default {@link DEFAULT_CALL_TIMEOUT_MS}). Returns the `callId` immediately (synchronously)
   * alongside the result promise. */
  call: (session: CallSession, name: string, args: Record<string, unknown>, timeoutMs?: number) => StartedCall;
  /** Routes a validated `tool_result` frame; unknown correlation ids are dropped. */
  handleToolResult: (message: ToolResultMessage) => void;
  /** Routes a validated `tool_error` frame; unknown correlation ids are dropped. */
  handleToolError: (message: ToolErrorMessage) => void;
  /** Routes a validated `tool_call_progress` frame to the event bus; unknown correlation ids are
   * dropped (no event is emitted). */
  handleToolCallProgress: (message: ToolCallProgressMessage) => void;
  /** Sends `tool_cancel` for a still-pending call. Does not itself resolve/reject the pending
   * call — the app's eventual `tool_error` (`tool_cancelled`) or a late `tool_result` still wins
   * normally, and the existing timeout remains a backstop if the app never replies. Returns
   * `false` (a no-op, not an error) when `callId` is unknown/already finished, or when the
   * session has no active socket to send the frame on right now. */
  cancel: (sessionId: string, callId: string, reason: string) => boolean;
  /** Rejects every pending call for a session immediately (suspend/revoke/expiry transitions). */
  rejectSession: (sessionId: string, errorType: "session_suspended" | "unknown_session") => void;
  /** Rejects and clears every pending call across every session (daemon shutdown). */
  disposeAll: () => void;
};

type PendingCall = {
  alias: string;
  resolve: (result: unknown) => void;
  reject: (error: RpcApplicationError) => void;
  timer: TimerHandle;
};

const generateCallId = (): string => `call_${randomBytes(16).toString("base64url")}`;

/** Extra headroom added on top of the daemon-side deadline so a caller's transport timeout never
 * beats the daemon's own `tool_timeout` — mirrored (deliberately duplicated) in
 * `client/app-client.ts`, which must not import daemon-internal modules. */
export const CALL_TRANSPORT_TIMEOUT_SLACK_MS = 5_000;

/** The deadline the daemon will actually enforce for a `tools.call` with this `timeoutMs`. */
export const clampTimeout = (timeoutMs: number | undefined): number => {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_CALL_TIMEOUT_MS;
  }

  return clampToolTimeoutMs(timeoutMs);
};

/** Transport timeout a caller should use for a `tools.call` that will be given `timeoutMs`
 * daemon-side. Always clamps first: adding slack to an unclamped value could overflow Node's
 * 32-bit timer range (~24.8 days), which silently fires the timer immediately. */
export const deriveCallTransportTimeoutMs = (timeoutMs: number | undefined): number => {
  return clampTimeout(timeoutMs) + CALL_TRANSPORT_TIMEOUT_SLACK_MS;
};

/** Event kinds that terminate every pending call for a session (ARCHITECTURE.md §6/§5: "On
 * suspend/revoke/expiry, every pending call rejects immediately with session_suspended (or
 * unknown_session on revoke)"). Expiry only ever follows suspend (pending calls are already gone
 * by then), but it is handled defensively with the same `unknown_session` type as revoke. */
const TERMINATING_KIND_ERROR_TYPES = {
  session_suspended: "session_suspended",
  session_revoked: "unknown_session",
  session_expired: "unknown_session",
} as const;

export const createCallsManager = (options: CallsManagerOptions): CallsManager => {
  const timers = options.timers ?? systemTimers;
  // sessionId -> callId -> PendingCall. Concurrent calls to the same session get independent
  // entries here, keyed by their own call id, so out-of-order tool_result/tool_error frames still
  // resolve the right caller.
  const pendingBySession = new Map<string, Map<string, PendingCall>>();

  const takePending = (sessionId: string, callId: string): PendingCall | undefined => {
    const sessionMap = pendingBySession.get(sessionId);
    const pending = sessionMap?.get(callId);

    if (!sessionMap || !pending) {
      return undefined;
    }

    sessionMap.delete(callId);

    if (sessionMap.size === 0) {
      pendingBySession.delete(sessionId);
    }

    timers.clearTimeout(pending.timer);
    return pending;
  };

  const call = (
    session: CallSession,
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): StartedCall => {
    const callId = generateCallId();

    const result = new Promise<unknown>((resolve, reject) => {
      const effectiveTimeoutMs = clampTimeout(timeoutMs);

      const timer = timers.setTimeout(() => {
        const pending = takePending(session.sessionId, callId);
        pending?.reject(
          new RpcApplicationError("tool_timeout", `Tool call "${name}" timed out after ${effectiveTimeoutMs}ms.`),
        );
      }, effectiveTimeoutMs);

      let sessionMap = pendingBySession.get(session.sessionId);

      if (!sessionMap) {
        sessionMap = new Map();
        pendingBySession.set(session.sessionId, sessionMap);
      }

      sessionMap.set(callId, { alias: session.alias, resolve, reject, timer });

      const message: ToolCallMessage = {
        type: "tool_call",
        session_id: session.sessionId,
        id: callId,
        name,
        args,
      };

      const sent = options.send(session.sessionId, message);

      if (!sent) {
        const pending = takePending(session.sessionId, callId);
        pending?.reject(new RpcApplicationError("session_not_active", "Session has no active socket."));
      }
    });

    return { callId, result };
  };

  const handleToolResult = (message: ToolResultMessage): void => {
    const pending = takePending(message.session_id, message.id);
    pending?.resolve(message.result);
  };

  const handleToolError = (message: ToolErrorMessage): void => {
    const pending = takePending(message.session_id, message.id);
    // Verbatim: `error.type` comes straight from the app's frame, never re-wrapped (v1's defect).
    pending?.reject(new RpcApplicationError(message.error.type, message.error.message, -32000, message.error.details));
  };

  const handleToolCallProgress = (message: ToolCallProgressMessage): void => {
    const sessionMap = pendingBySession.get(message.session_id);
    const pending = sessionMap?.get(message.id);

    if (!pending) {
      // Unknown correlation id: dropped (ARCHITECTURE.md task notes say "log at debug level"; a
      // full logging seam doesn't exist yet in the daemon, so this is a silent, intentional no-op).
      return;
    }

    options.eventBus.emit({
      // Its own EventKind (ARCHITECTURE.md §5), distinct from `tool_call_started`/
      // `tool_call_finished` — subscribers correlate all three by `callId` in `data` without
      // needing to sniff which kind carries a `progress`/`message` field.
      kind: "tool_call_progress",
      sessionId: message.session_id,
      alias: pending.alias,
      data: { callId: message.id, progress: message.progress, message: message.message },
    });
  };

  const cancel = (sessionId: string, callId: string, reason: string): boolean => {
    const pending = pendingBySession.get(sessionId)?.get(callId);

    if (!pending) {
      return false;
    }

    const message: ToolCancelMessage = { type: "tool_cancel", session_id: sessionId, id: callId, reason };
    return options.sendCancel(sessionId, message);
  };

  const rejectSession = (sessionId: string, errorType: "session_suspended" | "unknown_session"): void => {
    const sessionMap = pendingBySession.get(sessionId);

    if (!sessionMap) {
      return;
    }

    pendingBySession.delete(sessionId);

    for (const pending of sessionMap.values()) {
      timers.clearTimeout(pending.timer);
      pending.reject(new RpcApplicationError(errorType, `Session transitioned while the call was pending.`));
    }
  };

  const unsubscribeFromEventBus = options.eventBus.subscribe((event) => {
    const errorType = (TERMINATING_KIND_ERROR_TYPES as Record<string, "session_suspended" | "unknown_session">)[
      event.kind
    ];

    if (errorType && event.sessionId) {
      rejectSession(event.sessionId, errorType);
    }
  });

  const disposeAll = (): void => {
    unsubscribeFromEventBus();

    for (const sessionId of Array.from(pendingBySession.keys())) {
      rejectSession(sessionId, "unknown_session");
    }
  };

  return { call, handleToolResult, handleToolError, handleToolCallProgress, cancel, rejectSession, disposeAll };
};
