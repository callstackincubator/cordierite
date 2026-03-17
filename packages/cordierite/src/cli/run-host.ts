import { handleHostCommand } from "../commands/host.js";
import { createHostDeviceStatusReporter } from "../host-device-status.js";
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

  const deviceStatus =
    writers.stdout.isTTY === true && !json
      ? createHostDeviceStatusReporter({
          color,
          write(chunk) {
            writers.stderr.write(chunk);
          },
        })
      : undefined;

  return executeHostedCommand(
    "host",
    () =>
      handleHostCommand(toHostCommandOptions(parsedOptions), {
        clock,
        deviceStatus,
      }),
    {
      json,
      color,
      stdout: writers.stdout,
      stderr: writers.stderr,
      clock,
      deviceStatus,
    },
  );
};
