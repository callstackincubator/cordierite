/**
 * The typed client handle (issue #8) returned by {@link connect}/{@link waitForSession}: a thin
 * wrapper over the same `tools.list`/`tools.call`/`events.subscribe` RPC the CLI and MCP server use
 * (`rpc/client.ts`'s `DaemonStream`), bound to one resolved session. No new privilege or transport —
 * every call is attributed `caller: "client"` for the audit log (ARCHITECTURE.md §12).
 */
import { RPC_METHODS, type EventNotification, type ToolDescriptor, type ToolsCallResult, type ToolsListResult } from "@cordierite/shared";

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
};

/** An app-pushed event (`postEvent(name, payload)`), narrowed from the daemon's generic
 * `EventNotification` envelope to the shape a `waitForEvent` caller actually wants. */
export type AppEvent<TPayload = unknown> = {
  name: string;
  payload: TPayload;
  /** Unix ms. */
  ts: number;
  sessionId: string;
  alias?: string;
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

  /**
   * Waits for the next `app_event` (as pushed by the connected app's `postEvent(name, payload)`)
   * matching `name`. **Races**: this subscribes live and has no visibility into events emitted
   * before the subscription lands (there is no daemon-side retention yet — see
   * https://github.com/callstackincubator/cordierite/issues/6). Call it before triggering the
   * action that emits the event, not after.
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

    waitForEvent: (name: string, options: WaitForEventOptions = {}): Promise<AppEvent> => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS;

      return new Promise<AppEvent>((resolve, reject) => {
        let settled = false;

        const settle = (fn: () => void): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          unsubscribeNotification();
          unsubscribeClose();
          fn();
        };

        const timer = setTimeout(() => {
          settle(() =>
            reject(new CordieriteError("timeout", `Timed out after ${timeoutMs}ms waiting for event "${name}".`)),
          );
        }, timeoutMs);

        const unsubscribeClose = stream.onClose(() => {
          settle(() =>
            reject(
              new CordieriteError(
                "connection_error",
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

          if (event.kind !== "app_event" || event.sessionId !== sessionId) {
            return;
          }

          const data = event.data as { name?: unknown; payload?: unknown };

          if (data.name !== name) {
            return;
          }

          try {
            if (options.match && !options.match(data.payload)) {
              return;
            }
          } catch (error) {
            settle(() => reject(toCordieriteError(error)));
            return;
          }

          settle(() =>
            resolve({ name, payload: data.payload, ts: event.ts, sessionId: event.sessionId!, alias: event.alias }),
          );
        });

        stream.call(RPC_METHODS.eventsSubscribe, { sessionSelector: sessionId, kinds: ["app_event"] }).catch((error) => {
          settle(() => reject(toCordieriteError(error)));
        });
      });
    },

    close: (): void => {
      stream.close();
    },
  };

  return client as unknown as AppClient<TTools>;
};
