/**
 * The typed client handle (issue #8) returned by {@link connect}/{@link waitForSession}: a thin
 * wrapper over the same `tools.list`/`tools.call`/`events.subscribe`/`events.since` RPC the CLI and
 * MCP server use (`rpc/client.ts`'s `DaemonStream`), bound to one resolved session. No new privilege
 * or transport — every call is attributed `caller: "client"` for the audit log (ARCHITECTURE.md
 * §12). {@link AppClient.waitForEvent}'s drain-then-live pattern mirrors the built-in
 * `cordierite_wait_for_event` MCP tool (`mcp/events-tool.ts`) — see that module's doc comment for
 * why the notification listener has to be registered before the `events.since` drain call is sent.
 */
import {
  RPC_METHODS,
  type EventNotification,
  type EventsSinceResult,
  type ToolDescriptor,
  type ToolsCallResult,
  type ToolsListResult,
} from "@cordierite/shared";

import type { DaemonStream } from "../rpc/client.js";
import { CordieriteError, toCordieriteError } from "./errors.js";

/** A project's own tool map — declared once, e.g. `type Tools = { sum: { args: { a: number; b:
 * number }; result: { total: number } } }` — to get typed {@link AppClient.call} throughout a test
 * suite. Tool names and arg/result types can't be statically known here (they're registered by the
 * connected app at runtime): the default `result` is `any` so the untyped form (`connect()` with no
 * generic) still lets a caller destructure a call's result without a cast, e.g. `const { total } =
 * await app.call("sum", { a: 2, b: 3 })`. `AppClient` itself is deliberately unconstrained (no
 * `extends Record<string, ...>`) so both `type` aliases and plain `interface`s work here — TS only
 * infers an implicit index signature for the former, so a constrained generic would silently reject
 * the latter. */
export type ToolMap = Record<string, { args: Record<string, unknown>; result: any }>;

type ToolArgs<TTools, K extends keyof TTools> = TTools[K] extends { args: infer TArgs } ? TArgs : Record<string, unknown>;
type ToolResult<TTools, K extends keyof TTools> = TTools[K] extends { result: infer TResult } ? TResult : unknown;

export type CallOptions = {
  /** Forwarded to the daemon as the tool's own deadline (clamped server-side to [1s, 600s],
   * default 10s) — NOT this call's transport timeout, which is derived from it automatically so a
   * `tool_timeout` from the daemon always arrives before this client's own transport timeout would
   * otherwise fire and misreport it as `connection_error`. */
  timeoutMs?: number;
};

export type WaitForEventOptions = {
  /** Defaults to 30s. */
  timeoutMs?: number;
  /** Extra filter over the event's payload; the event still must match `name` first. A predicate
   * that throws rejects the wait with that error rather than crashing the connection. */
  match?: (payload: unknown) => boolean;
  /**
   * Exclusive lower bound on `AppEvent.seq` (a cursor from a previous {@link AppClient.events} or
   * {@link AppClient.waitForEvent} call) — skips already-retained events at/before it instead of
   * resolving with an old match instantly. Omitted, the retained buffer is searched from its start,
   * so a matching event that already fired before this call still resolves immediately.
   */
  since?: number;
};

export type EventsOptions = {
  /** Exclusive lower bound on `AppEvent.seq`; omitted returns the whole retained buffer (oldest
   * first, subject to `limit`). */
  since?: number;
  /** Caps the number of events returned (oldest-first truncation); omitted returns everything
   * matching `since` up to the buffer's own retention limit. */
  limit?: number;
};

export type EventsResult = {
  events: AppEvent[];
  /** The highest `seq` currently retained for this session (not just among the returned events) —
   * pass it back as `since`/`since` on the next {@link AppClient.events}/{@link
   * AppClient.waitForEvent} call to resume after it. */
  cursor: number;
};

/** An app-pushed event (`postEvent(name, payload)`), narrowed from the daemon's generic
 * `EventNotification` envelope to the shape a `waitForEvent`/`events` caller actually wants. */
export type AppEvent<TPayload = unknown> = {
  name: string;
  payload: TPayload;
  /** Unix ms. */
  ts: number;
  sessionId: string;
  alias?: string;
  /** Monotonically increasing per-session cursor (ARCHITECTURE.md §5) assigned by the daemon's
   * retention buffer at emit time — pass back into `since` to resume after this event. */
  seq: number;
};

export type AppClient<TTools = ToolMap> = {
  readonly sessionId: string;

  /** `tools.list` for this session. */
  tools(): Promise<ToolDescriptor[]>;

  /** `tools.call`; rejects with a {@link CordieriteError} whose `type` preserves the wire error
   * type verbatim (e.g. `"tool_timeout"`, `"policy_denied"`, `"session_suspended"`). */
  call<K extends keyof TTools & string>(
    name: K,
    args: ToolArgs<TTools, K>,
    options?: CallOptions,
  ): Promise<ToolResult<TTools, K>>;

  /** Drains `app_event`s retained in the daemon's per-session ring buffer since a cursor — the pull
   * counterpart to {@link AppClient.waitForEvent}, for checking what already happened instead of
   * waiting for the next one. Pass `cursor` from the result back as `since` on the next call to
   * avoid re-reading events already seen. */
  events(options?: EventsOptions): Promise<EventsResult>;

  /**
   * Waits for the next `app_event` (as pushed by the connected app's `postEvent(name, payload)`)
   * matching `name`. Checks the daemon's retained buffer for an already-arrived match first, then
   * falls back to a live wait — so an event emitted between "the caller decides to wait" and "the
   * subscription lands" is never missed; pass `since` (a cursor from a previous {@link
   * AppClient.events}/`waitForEvent` call) to skip events already handled and wait only for a new
   * one, since omitting it can return an old match instantly on every call.
   *
   * This shares the connection's single `events.subscribe` filter (the daemon keeps one per
   * connection, replaced — not merged — on each call); concurrent `waitForEvent` calls on the same
   * `AppClient` all see every `app_event`, so this is safe today, but it means the connection stays
   * subscribed to `app_event` for its lifetime once any `waitForEvent` has run.
   */
  waitForEvent<TPayload = unknown>(name: string, options?: WaitForEventOptions): Promise<AppEvent<TPayload>>;

  /** Closes the underlying connection. Safe to call more than once. */
  close(): void;
};

const DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS = 30_000;

/** Mirrors `daemon/calls.ts`'s `DEFAULT_CALL_TIMEOUT_MS`/`MIN_CALL_TIMEOUT_MS`/
 * `MAX_CALL_TIMEOUT_MS` clamp so this client can compute a transport timeout that always exceeds
 * whatever server-side deadline the daemon will actually enforce for a given `timeoutMs` — not
 * imported directly to keep `cordierite/client` from pulling in daemon-internal modules. */
const DAEMON_DEFAULT_CALL_TIMEOUT_MS = 10_000;
const DAEMON_MIN_CALL_TIMEOUT_MS = 1_000;
const DAEMON_MAX_CALL_TIMEOUT_MS = 600_000;
/** Extra headroom so the daemon's own `tool_timeout` always wins the race against this client's
 * transport timeout, even accounting for RPC round-trip and event-loop scheduling delay. */
const CALL_TRANSPORT_TIMEOUT_SLACK_MS = 5_000;

const transportTimeoutForToolCall = (timeoutMs: number | undefined): number => {
  const clamped =
    timeoutMs === undefined || !Number.isFinite(timeoutMs)
      ? DAEMON_DEFAULT_CALL_TIMEOUT_MS
      : Math.min(Math.max(Math.trunc(timeoutMs), DAEMON_MIN_CALL_TIMEOUT_MS), DAEMON_MAX_CALL_TIMEOUT_MS);

  return clamped + CALL_TRANSPORT_TIMEOUT_SLACK_MS;
};

export const makeAppClient = <TTools = ToolMap>(stream: DaemonStream, sessionId: string): AppClient<TTools> => {
  const client = {
    sessionId,

    tools: async (): Promise<ToolDescriptor[]> => {
      try {
        return await stream.call<ToolsListResult>(RPC_METHODS.toolsList, { selector: sessionId });
      } catch (error) {
        throw toCordieriteError(error);
      }
    },

    call: async (name: string, args: Record<string, unknown>, options?: CallOptions): Promise<unknown> => {
      try {
        const result = await stream.call<ToolsCallResult>(
          RPC_METHODS.toolsCall,
          {
            selector: sessionId,
            name,
            args,
            timeoutMs: options?.timeoutMs,
            caller: "client",
          },
          transportTimeoutForToolCall(options?.timeoutMs),
        );

        return result.result;
      } catch (error) {
        throw toCordieriteError(error);
      }
    },

    events: async (options: EventsOptions = {}): Promise<EventsResult> => {
      try {
        const result = await stream.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
          selector: sessionId,
          since: options.since,
          limit: options.limit,
          kinds: ["app_event"],
        });

        return {
          events: result.events
            .map((event) => appEventFrom(event, sessionId))
            .filter((event): event is AppEvent => event !== undefined),
          cursor: result.cursor,
        };
      } catch (error) {
        throw toCordieriteError(error);
      }
    },

    waitForEvent: (name: string, options: WaitForEventOptions = {}): Promise<AppEvent> => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS;

      const toMatch = (event: EventNotification): AppEvent | undefined => {
        const appEvent = appEventFrom(event, sessionId);

        if (!appEvent || appEvent.name !== name) {
          return undefined;
        }

        if (options.match && !options.match(appEvent.payload)) {
          return undefined;
        }

        return appEvent;
      };

      return new Promise<AppEvent>((resolve, reject) => {
        let settled = false;

        const settle = (fn: () => void): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          unsubscribeClose();
          liveHandler = null;
          fn();
        };

        const timer = setTimeout(() => {
          settle(() =>
            reject(new CordieriteError("timeout", `Timed out after ${timeoutMs}ms waiting for event "${name}".`)),
          );
        }, timeoutMs);

        // Registered before `events.since` is even sent (not merely before it resolves): the
        // daemon's response to that call and a `notify()` for a brand-new event can arrive in the
        // same socket chunk, and a listener added only after awaiting that response could miss a
        // notification from that same chunk. Buffers into `earlyEvents` until the drain below has
        // merged its own backlog and switched this to `liveHandler`.
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

        const fail = (error: unknown): void => {
          settle(() => reject(toCordieriteError(error)));
          unsubscribeNotification();
        };

        (async () => {
          await stream.call(RPC_METHODS.eventsSubscribe, { sessionSelector: sessionId, kinds: ["app_event"] });

          const sinceResult = await stream.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
            selector: sessionId,
            since: options.since,
            kinds: ["app_event"],
          });

          // Merge the retained backlog with whatever arrived on the live channel while the two
          // calls above were in flight, deduped by `seq` — the same event can legitimately show up
          // in both (the daemon buffers before it fans out). Everything from here to `liveHandler =
          // …` below is synchronous — no `await` — so nothing can arrive on the socket and be missed
          // in the gap.
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
            try {
              const matched = toMatch(event);

              if (matched) {
                settle(() => resolve(matched));
                unsubscribeNotification();
                return;
              }
            } catch (error) {
              fail(error);
              return;
            }
          }

          // Nothing matched yet: resume live from the last event actually considered, or — if
          // nothing was retained/arrived at all — `events.since`'s own cursor, which already
          // reflects the session's true high-water mark even when the `kinds` filter matched
          // nothing.
          const highestConsideredSeq = backlog.length > 0 ? backlog[backlog.length - 1]!.seq : sinceResult.cursor;

          unsubscribeClose = stream.onClose(() => {
            settle(() =>
              reject(
                new CordieriteError(
                  "connection_error",
                  `The connection to the Cordierite daemon closed while waiting for event "${name}".`,
                ),
              ),
            );
            unsubscribeNotification();
          });

          // From here on, every notification goes straight to this handler instead of
          // `earlyEvents` — assigned synchronously (no `await` since the backlog scan above), so
          // nothing is missed.
          liveHandler = (event) => {
            if (settled) {
              return;
            }

            if (event.sessionId === sessionId && event.seq <= highestConsideredSeq) {
              return;
            }

            try {
              const matched = toMatch(event);

              if (matched) {
                settle(() => resolve(matched));
                unsubscribeNotification();
              }
            } catch (error) {
              fail(error);
            }
          };
        })().catch((error) => {
          fail(error);
        });
      });
    },

    close: (): void => {
      stream.close();
    },
  };

  return client as unknown as AppClient<TTools>;
};

const appEventFrom = (event: EventNotification, sessionId: string): AppEvent | undefined => {
  if (event.kind !== "app_event" || event.sessionId !== sessionId) {
    return undefined;
  }

  const data = event.data as { name?: unknown; payload?: unknown };

  if (typeof data.name !== "string") {
    return undefined;
  }

  return {
    name: data.name,
    payload: data.payload,
    ts: event.ts,
    sessionId: event.sessionId!,
    alias: event.alias,
    seq: event.seq,
  };
};
