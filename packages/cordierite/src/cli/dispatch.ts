import {
  handleDaemonRunCommand,
  handleDaemonStartCommand,
  handleDaemonStatusCommand,
  handleDaemonStopCommand,
} from "../commands/daemon.js";
import { handleKeygenCommand } from "../commands/keygen.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import { usageError } from "../errors.js";
import { createCli } from "./create-cli.js";
import { executeCommand, executeHostedCommand } from "./runner.js";
import { systemClock } from "./types.js";
import type { RunCliOptions } from "./types.js";

export const runCli = async (argv: string[], options: RunCliOptions = {}): Promise<number> => {
  const writers = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
  const clock = options.clock ?? systemClock;
  const prompt = {
    input: options.stdin ?? process.stdin,
    output: options.promptOutput ?? process.stderr,
  };

  const cli = createCli();

  try {
    cli.parse(["bun", "cordierite", ...argv], {
      run: false,
    });
  } catch (error) {
    return executeCommand(
      "cli",
      () => {
        throw error;
      },
      {
        json: argv.includes("--json"),
        color: !argv.includes("--no-color"),
        stdout: writers.stdout,
        stderr: writers.stderr,
        clock,
      },
    );
  }

  const matchedCommand = cli.matchedCommandName;
  const parsedOptions = cli.options as Record<string, unknown>;
  const parsedArgs = cli.args;

  if (parsedOptions.help || parsedOptions.version) {
    return 0;
  }

  if (!matchedCommand) {
    if (parsedArgs[0]) {
      return executeCommand(
        "cli",
        () => {
          throw usageError(`Unknown command "${parsedArgs[0]}".`);
        },
        {
          json: Boolean(parsedOptions.json),
          color: parsedOptions.color !== false,
          stdout: writers.stdout,
          stderr: writers.stderr,
          clock,
        },
      );
    }

    cli.outputHelp();
    return 0;
  }

  const json = Boolean(parsedOptions.json);
  const color = parsedOptions.color !== false;
  const io = { json, color, stdout: writers.stdout, stderr: writers.stderr, clock };
  const stateDir = resolveStateDir();

  switch (matchedCommand) {
    case "keygen":
      return executeCommand(
        "keygen",
        () =>
          handleKeygenCommand(
            {},
            {
              prompt,
            },
          ),
        io,
      );

    case "daemon": {
      const action = parsedArgs[0];

      switch (action) {
        case "run":
          return executeHostedCommand(
            "daemon run",
            () => handleDaemonRunCommand({ stateDir, clock }),
            io,
          );

        case "start":
          return executeCommand("daemon start", () => handleDaemonStartCommand({ stateDir, clock }), io);

        case "stop":
          return executeCommand("daemon stop", () => handleDaemonStopCommand({ stateDir, clock }), io);

        case "status":
          return executeCommand("daemon status", () => handleDaemonStatusCommand({ stateDir, clock }), io);

        default:
          return executeCommand(
            "daemon",
            () => {
              throw usageError(
                `The daemon command requires an action: run, start, stop, or status (got ${
                  action === undefined ? "none" : `"${action}"`
                }).`,
              );
            },
            io,
          );
      }
    }

    default:
      return executeCommand(
        matchedCommand,
        () => {
          throw usageError(`Unknown command "${matchedCommand}".`);
        },
        io,
      );
  }
};
