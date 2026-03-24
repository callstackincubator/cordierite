import { handleHostCommand } from "../commands/host.js";
import { noopHostEventSink } from "../host-events.js";
import {
  createInteractiveHostReporter,
  createPlainTextHostReporter,
  type HostReporter,
} from "../host-reporters.js";
import type { Clock } from "../runtime.js";
import { toHostCommandOptions } from "./command-options.js";
import { executeHostedCommand } from "./runner.js";
import type { CliIoWriters } from "./types.js";

type HostCliContext = {
  json: boolean;
  color: boolean;
  writers: CliIoWriters;
  clock: Clock;
};

/**
 * Runs the `host` subcommand: optional interactive QR on stderr, then long-lived WSS host
 * until SIGINT/SIGTERM.
 */
export const runHostSubcommand = async (
  parsedOptions: Record<string, unknown>,
  ctx: HostCliContext,
): Promise<number> => {
  const { json, color, writers, clock } = ctx;
  let reporter: HostReporter | undefined;

  if (!json) {
    reporter =
      writers.stdout.isTTY === true
        ? createInteractiveHostReporter({
            color,
            writer: {
              write(chunk) {
                writers.stderr.write(chunk);
              },
            },
          })
        : createPlainTextHostReporter({
            color,
            writer: {
              write(chunk) {
                writers.stderr.write(chunk);
              },
            },
          });
  }

  const hostEvents = reporter
    ? {
        emitHostEvent(event: Parameters<HostReporter["onEvent"]>[0]) {
          void reporter?.onEvent(event);
        },
      }
    : noopHostEventSink;

  return executeHostedCommand(
    "host",
    () =>
      handleHostCommand(toHostCommandOptions(parsedOptions), {
        clock,
        hostEvents,
      }),
    {
      json,
      color,
      stdout: writers.stdout,
      stderr: writers.stderr,
      clock,
      reporter,
    },
  );
};
