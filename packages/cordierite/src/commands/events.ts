/**
 * `cordierite events` (ARCHITECTURE.md §10): subscribes to `events.subscribe` over a persistent
 * connection and streams notifications until interrupted (Ctrl-C) or the connection drops. This is
 * the one command whose output isn't a single rendered `CliResult` — each event is written as it
 * arrives (NDJSON under `--json`, a human line otherwise) — so it plugs into `executeHostedCommand`
 * with a live reporter that suppresses the default one-shot bootstrap render (`cli/runner.ts`).
 *
 * `--since <cursor>` (issue #6) switches to a one-shot mode: a single `events.since` pull instead
 * of a live subscription. It falls out of the same `EventsHostedResult` shape (each retained event
 * is written through `onEvent` exactly like a live one) so the CLI plumbing needs no forking — the
 * "hosted command" here just completes immediately instead of running until interrupted.
 */

import { RPC_METHODS, type EventNotification, type EventsSinceResult, type EventsSubscribeResult } from "@cordierite/shared";

import type { CliResult } from "../cli/result-types.js";
import { openDaemonStream, type SpawnFn } from "../rpc/client.js";

export type EventsCommandOptions = {
  selector?: string;
  /** Exclusive lower bound on `EventNotification.seq`; switches this command to a one-shot
   * `events.since` pull instead of a live `events.subscribe` stream. */
  since?: number;
};

export type EventsCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
  onEvent: (event: EventNotification) => void;
};

export type EventsHostedResult = {
  result: CliResult<never>;
  completion: Promise<void>;
  stop: () => void;
};

const NEVER_RESULT: CliResult<never> = { ok: true, data: undefined as never };

const handleEventsSinceCommand = async (
  options: EventsCommandOptions,
  context: EventsCommandContext,
): Promise<EventsHostedResult> => {
  const stream = await openDaemonStream({ stateDir: context.stateDir, spawn: context.spawn });

  try {
    const since = await stream.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
      selector: options.selector,
      since: options.since,
    });

    for (const event of since.events) {
      context.onEvent(event);
    }
  } finally {
    stream.close();
  }

  return { result: NEVER_RESULT, completion: Promise.resolve(), stop: () => {} };
};

export const handleEventsCommand = async (
  options: EventsCommandOptions,
  context: EventsCommandContext,
): Promise<EventsHostedResult> => {
  if (options.since !== undefined) {
    return handleEventsSinceCommand(options, context);
  }

  const stream = await openDaemonStream({ stateDir: context.stateDir, spawn: context.spawn });

  try {
    await stream.call<EventsSubscribeResult>(RPC_METHODS.eventsSubscribe, {
      sessionSelector: options.selector,
    });
  } catch (error) {
    stream.close();
    throw error;
  }

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const unsubscribeNotifications = stream.onNotification((payload) => {
    context.onEvent(payload as EventNotification);
  });

  let unsubscribeClose = (): void => {};
  let stopped = false;
  const stop = (): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    unsubscribeNotifications();
    unsubscribeClose();
    stream.close();
    resolveCompletion();
  };

  // The daemon going away mid-stream (shutdown, crash) must end the command gracefully rather than
  // hang forever waiting for a Ctrl-C that will never resolve anything.
  unsubscribeClose = stream.onClose(stop);

  return {
    // Never rendered: the reporter passed to `executeHostedCommand` suppresses the bootstrap
    // render for this command (see the doc comment above).
    result: { ok: true, data: undefined as never },
    completion,
    stop,
  };
};
