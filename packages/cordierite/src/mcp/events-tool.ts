/**
 * The built-in `cordierite_events` / `cordierite_wait_for_event` MCP tools (issue #6): a pull
 * surface over the daemon's `app_event` plumbing (`postEvent()` on the app side, `events.since`'s
 * per-session retention buffer on the daemon side — see `daemon/event-bus.ts`). MCP is
 * request/response, so an agent otherwise has no way to observe anything the app pushes.
 *
 * `cordierite_wait_for_event` drains the retained buffer for an already-arrived match before
 * falling back to a live wait, exactly to avoid the race `cordierite_wait_for_session` doesn't
 * have to worry about (a session is either claimed or it isn't, but an `app_event` can easily fire
 * between "the agent decides to wait" and "the wait subscription lands"). The buffer read and the
 * live subscription overlap by design (both start from the same resolved session and the same
 * `app_event` filter) — events already accounted for by the buffer read are deduped by `seq` so a
 * late-arriving one over the live channel is never reported twice.
 */

import {
  RPC_METHODS,
  type EventKind,
  type EventNotification,
  type EventsSinceResult,
  type SessionsDescribeResult,
} from "@cordierite/shared";

import { DaemonRpcError, openDaemonStream, type SpawnFn } from "../rpc/client.js";
import type { DaemonCall } from "./daemon-tools.js";
import { McpBuiltinToolError } from "./connect-tool.js";

export const EVENTS_TOOL_NAME = "cordierite_events";
export const WAIT_FOR_EVENT_TOOL_NAME = "cordierite_wait_for_event";

const DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS = 120_000;
/** Kept safely under the 30-minute idle window a stdio MCP server gets before Claude Code aborts a
 * tool call that has sent neither a response nor a progress notification (issue #6's "Constraint on
 * the blocking wait tool") — with margin for RPC round-trip and scheduling delay. */
const MAX_WAIT_FOR_EVENT_TIMEOUT_MS = 25 * 60 * 1000;
/** How often a progress notification is emitted during a live wait, when the caller supplied a
 * progress token — informational only (the timeout cap above is what actually keeps the call
 * within the idle window), but it gives a caller watching progress something to show. */
const WAIT_FOR_EVENT_PROGRESS_INTERVAL_MS = 60_000;

const KNOWN_EVENT_KINDS = new Set<string>([
  "daemon_started",
  "link_created",
  "link_expired",
  "session_claimed",
  "session_suspended",
  "session_resumed",
  "session_revoked",
  "session_expired",
  "tools_changed",
  "app_event",
  "tool_call_started",
  "tool_call_progress",
  "tool_call_finished",
]);

export const EVENTS_TOOL_DESCRIPTOR = {
  name: EVENTS_TOOL_NAME,
  description:
    "Drain events retained in the daemon's per-session ring buffer (ARCHITECTURE.md §5) since a " +
    "cursor — the pull counterpart to a live subscription, for checking what happened after " +
    "calling a tool or triggering app behavior. With no selector, targets the sole active/" +
    "suspended session. Returns { events, cursor }; pass cursor back as since on the next call to " +
    "avoid re-reading events you've already seen.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      since: { type: "number", minimum: 0 },
      kinds: { type: "array", items: { type: "string" } },
      limit: { type: "number", exclusiveMinimum: 0 },
    },
    additionalProperties: false,
  },
} as const;

export const WAIT_FOR_EVENT_TOOL_DESCRIPTOR = {
  name: WAIT_FOR_EVENT_TOOL_NAME,
  description:
    "Wait for the connected app to push an event via postEvent(name, payload) matching name (and, " +
    "if match is given, every one of its keys shallow-equal in the event's payload). Checks " +
    "already-retained events first, so an event that already fired before this call still resolves " +
    "immediately. Resolves with { sessionId, alias, name, payload, ts, seq }, or rejects with " +
    "tool_timeout after timeoutMs (default 120000ms, capped server-side at 1500000ms). A call " +
    "still running after about two minutes moves to a Claude Code background task, so the result " +
    "may arrive well after this call returns.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      name: { type: "string" },
      match: { type: "object" },
      timeoutMs: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

export type EventsToolDeps = {
  call: DaemonCall;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

const asOptionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a non-empty string.`);
  }

  return value;
};

const asOptionalNonNegativeNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a non-negative number.`);
  }

  return value;
};

const asOptionalPositiveNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a positive number.`);
  }

  return value;
};

const asOptionalEventKinds = (value: unknown): EventKind[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((kind) => typeof kind === "string" && KNOWN_EVENT_KINDS.has(kind))) {
    throw new McpBuiltinToolError("invalid_request", '"kinds" must be an array of known event kinds.');
  }

  return value as EventKind[];
};

const asOptionalMatch = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpBuiltinToolError("invalid_request", '"match" must be a JSON object.');
  }

  return value as Record<string, unknown>;
};

export const handleEventsTool = async (rawArgs: unknown, deps: EventsToolDeps): Promise<EventsSinceResult> => {
  const args = asRecord(rawArgs);

  return deps.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
    selector: asOptionalString(args.selector, "selector"),
    since: asOptionalNonNegativeNumber(args.since, "since"),
    kinds: asOptionalEventKinds(args.kinds),
    limit: asOptionalPositiveNumber(args.limit, "limit"),
  });
};

export type WaitForEventToolDeps = {
  stateDir: string;
  spawn?: SpawnFn;
  /** Present only when the incoming `tools/call` carried a progress token; used to emit periodic
   * "still waiting" progress notifications during a live wait. */
  progress?: {
    token: string | number;
    sendNotification: (notification: unknown) => Promise<void>;
  };
};

export type WaitForEventToolResult = {
  sessionId: string;
  alias?: string;
  name: string;
  payload: unknown;
  /** Unix ms. */
  ts: number;
  seq: number;
};

const payloadShallowMatches = (payload: unknown, match: Record<string, unknown>): boolean => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }

  const record = payload as Record<string, unknown>;

  return Object.entries(match).every(([key, value]) => record[key] === value);
};

export const handleWaitForEventTool = async (
  rawArgs: unknown,
  deps: WaitForEventToolDeps,
): Promise<WaitForEventToolResult> => {
  const args = asRecord(rawArgs);

  const selector = asOptionalString(args.selector, "selector");
  const name = asOptionalString(args.name, "name");

  if (!name) {
    throw new McpBuiltinToolError("invalid_request", '"name" must be a non-empty string.');
  }

  const match = asOptionalMatch(args.match);
  const requestedTimeoutMs = asOptionalPositiveNumber(args.timeoutMs, "timeoutMs") ?? DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS;
  const timeoutMs = Math.min(requestedTimeoutMs, MAX_WAIT_FOR_EVENT_TIMEOUT_MS);

  const stream = await openDaemonStream({ stateDir: deps.stateDir, spawn: deps.spawn });

  try {
    // Resolve the selector to one concrete session up front (same shape as
    // `handleWaitForSessionTool`) so the buffer drain below and the live subscription target the
    // exact same session — `events.subscribe`'s own `sessionSelector` has no "sole session" default,
    // so leaving it unresolved here would silently widen the live half of the wait to every session.
    let sessionId: string;
    let alias: string | undefined;

    try {
      const described = await stream.call<SessionsDescribeResult>(RPC_METHODS.sessionsDescribe, { selector });
      sessionId = described.sessionId;
      alias = described.alias;
    } catch (error) {
      throw error instanceof DaemonRpcError
        ? new McpBuiltinToolError("invalid_request", error.message)
        : error;
    }

    const toResult = (event: EventNotification): WaitForEventToolResult | undefined => {
      if (event.kind !== "app_event") {
        return undefined;
      }

      const data = event.data as { name?: unknown; payload?: unknown };

      if (data.name !== name) {
        return undefined;
      }

      if (match && !payloadShallowMatches(data.payload, match)) {
        return undefined;
      }

      return { sessionId, alias, name, payload: data.payload, ts: event.ts, seq: event.seq };
    };

    // Subscribe before draining the buffer: an `app_event` emitted in the gap between the two calls
    // below is then guaranteed to appear in the `since` snapshot (it landed on this connection's
    // socket before the `events.since` request was even sent), never only on the live channel.
    await stream.call(RPC_METHODS.eventsSubscribe, { sessionSelector: sessionId, kinds: ["app_event"] });

    const since = await stream.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
      selector: sessionId,
      kinds: ["app_event"],
    });

    let highestDrainedSeq = 0;

    for (const event of since.events) {
      highestDrainedSeq = Math.max(highestDrainedSeq, event.seq);
      const result = toResult(event);

      if (result) {
        return result;
      }
    }

    return await new Promise<WaitForEventToolResult>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

        if (progressTimer) {
          clearInterval(progressTimer);
        }

        unsubscribeNotification();
        unsubscribeClose();
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new McpBuiltinToolError(
              "tool_timeout",
              `Timed out after ${timeoutMs}ms waiting for event "${name}".`,
            ),
          ),
        );
      }, timeoutMs);

      const startedAt = Date.now();
      const progressTimer = deps.progress
        ? setInterval(() => {
            deps.progress!.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: deps.progress!.token,
                progress: Date.now() - startedAt,
                total: timeoutMs,
                message: `Still waiting for event "${name}"...`,
              },
            }).catch(() => {
              // A failed progress notification must never abort the wait itself.
            });
          }, WAIT_FOR_EVENT_PROGRESS_INTERVAL_MS)
        : undefined;

      const unsubscribeClose = stream.onClose(() => {
        settle(() =>
          reject(
            new McpBuiltinToolError(
              "tool_execution_error",
              `The connection to the Cordierite daemon closed while waiting for event "${name}".`,
            ),
          ),
        );
      });

      const unsubscribeNotification = stream.onNotification((payload) => {
        if (settled) {
          return;
        }

        const event = payload as EventNotification;

        // Already accounted for by the buffer drain above — the live channel re-delivers it too
        // (subscription started before the drain), so skip anything not strictly newer.
        if (event.sessionId === sessionId && event.seq <= highestDrainedSeq) {
          return;
        }

        const result = toResult(event);

        if (result) {
          settle(() => resolve(result));
        }
      });
    });
  } finally {
    stream.close();
  }
};
