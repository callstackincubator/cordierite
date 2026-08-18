/**
 * The built-in `cordierite_events` / `cordierite_wait_for_event` MCP tools (issue #6): a pull
 * surface over the daemon's `app_event` plumbing (`postEvent()` on the app side, `events.since`'s
 * per-session retention buffer on the daemon side — see `daemon/event-bus.ts`). MCP is
 * request/response, so an agent otherwise has no way to observe anything the app pushes.
 *
 * `cordierite_wait_for_event` drains the retained buffer for an already-arrived match before
 * falling back to a live wait, exactly to avoid the race `cordierite_wait_for_session` doesn't
 * have to worry about (a session is either claimed or it isn't, but an `app_event` can easily fire
 * between "the agent decides to wait" and "the wait subscription lands"). The live notification
 * listener is registered *before* the `events.since` drain call is even sent — not merely before
 * it resolves — because the daemon's response to that call and a subsequent `notify()` for a new
 * event can arrive in the same socket chunk; `rpc/client.ts` fans a chunk's notification lines out
 * to whatever listeners exist at the moment it's processed, so a listener added only after `await
 * stream.call(eventsSince, …)` returns can miss an event that was already in that same chunk.
 * Arrivals before the drain has been merged into the backlog are buffered, then merged in
 * (deduped by `seq`) before falling through to the live phase — see `handleWaitForEventTool` below.
 */

import {
  RPC_METHODS,
  EVENT_KINDS,
  type EventKind,
  type EventNotification,
  type EventsSinceResult,
  type SessionsDescribeResult,
} from "@cordierite/shared";

import { openDaemonStream, type SpawnFn } from "../rpc/client.js";
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

const KNOWN_EVENT_KINDS = new Set<string>(EVENT_KINDS);

/** Server-side cap on `timeoutMs` (issue #6's "Cap timeoutMs server-side below the idle window
 * rather than trusting the caller") — a pure function so the cap's boundary behavior is
 * unit-testable without spinning up a daemon or actually waiting out either bound. */
export const clampWaitForEventTimeoutMs = (requestedMs: number | undefined): number => {
  return Math.min(requestedMs ?? DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS, MAX_WAIT_FOR_EVENT_TIMEOUT_MS);
};

export const EVENTS_TOOL_DESCRIPTOR = {
  name: EVENTS_TOOL_NAME,
  description:
    "Drain events retained in the daemon's per-session ring buffer since a cursor — the pull " +
    "counterpart to a live subscription, for checking what happened after calling a tool or " +
    "triggering app behavior. With no selector, targets the sole active/suspended session. " +
    "Returns { events, cursor }; pass cursor back as since on the next call to avoid re-reading " +
    "events you've already seen. limit (if given) keeps the OLDEST events in the window and " +
    "advances cursor only past what was actually returned, so repeated calls page forward through " +
    "everything retained rather than skipping ahead.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      since: { type: "integer", minimum: 0 },
      kinds: { type: "array", items: { type: "string", enum: EVENT_KINDS } },
      limit: { type: "integer", exclusiveMinimum: 0 },
    },
    additionalProperties: false,
  },
} as const;

export const WAIT_FOR_EVENT_TOOL_DESCRIPTOR = {
  name: WAIT_FOR_EVENT_TOOL_NAME,
  description:
    "Wait for the connected app to push an event via postEvent(name, payload) matching name (and, " +
    "if match is given, every one of its keys strictly-equal — primitives only, not objects/arrays " +
    "— in the event's payload). Checks already-retained events first, so an event that already " +
    "fired before this call still resolves immediately; pass since (a cursor from a previous " +
    "cordierite_events/cordierite_wait_for_event call) to skip events you've already handled and " +
    "wait only for a new one — omitting it can return an old match instantly on every call. " +
    "Requires a claimed session to already exist (use cordierite_wait_for_session first if not). " +
    "Resolves with { sessionId, alias, name, payload, ts, seq }, or rejects with tool_timeout after " +
    "timeoutMs (default 120000ms, capped server-side at 1500000ms). A call still running after " +
    "about two minutes moves to a Claude Code background task, so the result may arrive well after " +
    "this call returns.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      name: { type: "string" },
      match: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
      since: { type: "integer", minimum: 0 },
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

/** `since`/`limit` mirror the daemon's own `asEventsSinceParams` (`daemon/daemon.ts`), which
 * requires integers — accepting e.g. `1.5` here would just round-trip to a `DaemonRpcError`
 * instead of this tool's own clearer `invalid_request`. */
const asOptionalNonNegativeInteger = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a non-negative integer.`);
  }

  return value;
};

const asOptionalPositiveInteger = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a positive integer.`);
  }

  return value;
};

/** `timeoutMs` is not required to be an integer (unlike the daemon's `since`/`limit`) — it's never
 * forwarded to the daemon verbatim, only used as this process's own `setTimeout` duration. */
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

type MatchPrimitive = string | number | boolean | null;

const isMatchPrimitive = (value: unknown): value is MatchPrimitive => {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
};

/** `payloadShallowMatches` compares with `===`, so an object/array value here could never equal
 * anything and would just make the wait time out with no explanation — reject it up front instead. */
const asOptionalMatch = (value: unknown): Record<string, MatchPrimitive> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpBuiltinToolError("invalid_request", '"match" must be a JSON object.');
  }

  const record = value as Record<string, unknown>;

  for (const [key, entry] of Object.entries(record)) {
    if (!isMatchPrimitive(entry)) {
      throw new McpBuiltinToolError(
        "invalid_request",
        `"match.${key}" must be a string, number, boolean, or null (objects/arrays can never match).`,
      );
    }
  }

  return record as Record<string, MatchPrimitive>;
};

export const handleEventsTool = async (rawArgs: unknown, deps: EventsToolDeps): Promise<EventsSinceResult> => {
  const args = asRecord(rawArgs);

  return deps.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
    selector: asOptionalString(args.selector, "selector"),
    since: asOptionalNonNegativeInteger(args.since, "since"),
    kinds: asOptionalEventKinds(args.kinds),
    limit: asOptionalPositiveInteger(args.limit, "limit"),
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

const payloadShallowMatches = (payload: unknown, match: Record<string, MatchPrimitive>): boolean => {
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
  const since = asOptionalNonNegativeInteger(args.since, "since");
  const timeoutMs = clampWaitForEventTimeoutMs(asOptionalPositiveNumber(args.timeoutMs, "timeoutMs"));

  const stream = await openDaemonStream({ stateDir: deps.stateDir, spawn: deps.spawn });

  try {
    // Resolve the selector to one concrete session up front (same shape as
    // `handleWaitForSessionTool`) so the buffer drain below and the live subscription target the
    // exact same session — `events.subscribe`'s own `sessionSelector` has no "sole session" default,
    // so leaving it unresolved here would silently widen the live half of the wait to every session.
    // A `DaemonRpcError` (no_session/ambiguous_session/unknown_session) propagates unchanged —
    // `toolErrorContentFromError` (mcp/server.ts) already maps it to its precise `data.type`.
    const described = await stream.call<SessionsDescribeResult>(RPC_METHODS.sessionsDescribe, { selector });
    const sessionId = described.sessionId;
    const alias = described.alias;

    const toResult = (event: EventNotification): WaitForEventToolResult | undefined => {
      if (event.kind !== "app_event" || event.sessionId !== sessionId) {
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

    // The notification listener is registered *before* `events.subscribe` is even sent, and starts
    // buffering into `earlyEvents` rather than resolving anything (`liveHandler` is still null) —
    // see the module doc comment for why: the `events.since` response and a `notify()` for a
    // brand-new event can arrive in the same socket chunk, and a listener added only after `await`ing
    // that response has already missed a notification line from that same chunk.
    let liveHandler: ((event: EventNotification) => void) | null = null;
    const earlyEvents: EventNotification[] = [];

    const unsubscribeNotification = stream.onNotification((payload) => {
      const event = payload as EventNotification;

      if (liveHandler) {
        liveHandler(event);
      } else {
        earlyEvents.push(event);
      }
    });

    let unsubscribeClose = (): void => {};

    try {
      await stream.call(RPC_METHODS.eventsSubscribe, { sessionSelector: sessionId, kinds: ["app_event"] });

      const sinceResult = await stream.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
        selector: sessionId,
        since,
        kinds: ["app_event"],
      });

      // Merge the retained backlog with whatever arrived on the live channel while the two calls
      // above were in flight, deduped by `seq` (the same event can legitimately show up in both:
      // the daemon buffers before it fans out, so a late-drained event and an in-flight live one can
      // be the same notification). Everything from here to `liveHandler = …` below is synchronous —
      // no `await` — so nothing can arrive on the socket and be missed in the gap.
      const seenSeqs = new Set<number>();
      const backlog: EventNotification[] = [];

      for (const event of [...sinceResult.events, ...earlyEvents]) {
        if (event.sessionId === sessionId && !seenSeqs.has(event.seq)) {
          seenSeqs.add(event.seq);
          backlog.push(event);
        }
      }

      backlog.sort((a, b) => a.seq - b.seq);

      for (const event of backlog) {
        const result = toResult(event);

        if (result) {
          return result;
        }
      }

      // Nothing matched yet: the cursor to resume live from is the last event actually considered
      // (backlog's own scan already covers everything since.events + earlyEvents jointly saw), or —
      // if nothing was retained/arrived at all — `events.since`'s own cursor, which (per
      // `event-bus.ts`'s `since()`) already reflects the session's true high-water mark even when
      // the `kinds` filter matched nothing.
      const highestConsideredSeq = backlog.length > 0 ? backlog[backlog.length - 1]!.seq : sinceResult.cursor;

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

          liveHandler = null;
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

        unsubscribeClose = stream.onClose(() => {
          settle(() =>
            reject(
              new McpBuiltinToolError(
                "tool_execution_error",
                `The connection to the Cordierite daemon closed while waiting for event "${name}".`,
              ),
            ),
          );
        });

        // From here on, every notification goes straight to this handler instead of `earlyEvents` —
        // assigned synchronously (no `await` since the backlog scan above), so nothing is missed.
        liveHandler = (event) => {
          if (settled) {
            return;
          }

          if (event.sessionId === sessionId && event.seq <= highestConsideredSeq) {
            return;
          }

          const result = toResult(event);

          if (result) {
            settle(() => resolve(result));
          }
        };
      });
    } finally {
      unsubscribeNotification();
      unsubscribeClose();
    }
  } finally {
    stream.close();
  }
};
