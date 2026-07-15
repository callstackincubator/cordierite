import type { EventNotification } from "@cordierite/shared";

import {
  handleDaemonRunCommand,
  handleDaemonStartCommand,
  handleDaemonStatusCommand,
  handleDaemonStopCommand,
} from "../commands/daemon.js";
import { handleEventsCommand } from "../commands/events.js";
import { handleInvokeCommand } from "../commands/invoke.js";
import { handleKeygenCommand } from "../commands/keygen.js";
import { handleLinkCommand } from "../commands/link.js";
import { handleLsCommand } from "../commands/ls.js";
import { handleRevokeCommand } from "../commands/revoke.js";
import { handleToolsCommand } from "../commands/tools.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import { usageError } from "../errors.js";
import { renderEventLine } from "../output.js";
import {
  parseJsonInputOption,
  parsePositiveIntegerOption,
  splitOptionalSelector,
  splitOptionalSelectorAndTarget,
  splitSelectorAndRequiredTarget,
} from "./command-options.js";
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
  const parsedArgs = cli.args as string[];

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
  const stateDir = resolveStateDir(
    typeof parsedOptions.stateDir === "string" ? parsedOptions.stateDir : undefined,
  );

  switch (matchedCommand) {
    case "keygen":
      return executeCommand(
        "keygen",
        () =>
          handleKeygenCommand(
            {
              out: typeof parsedOptions.out === "string" ? parsedOptions.out : undefined,
              force: Boolean(parsedOptions.force),
            },
            { stateDir },
          ),
        io,
      );

    case "link": {
      if (parsedOptions.open !== undefined) {
        // ARCHITECTURE.md §8's adb/simctl fast path lands in task 07; the flag is registered now
        // (create-cli.ts) purely so `--help` stays stable, per this task's scope note.
        return executeCommand(
          "link",
          () => {
            throw usageError('"--open" is not implemented yet (lands in a follow-up task).');
          },
          io,
        );
      }

      return executeCommand(
        "link",
        () =>
          handleLinkCommand(
            {
              ttlSeconds: parsePositiveIntegerOption(parsedOptions.ttl, "--ttl"),
              scheme: typeof parsedOptions.scheme === "string" ? parsedOptions.scheme : undefined,
            },
            { stateDir },
          ),
        {
          ...io,
          qr: Boolean(parsedOptions.qr),
        },
      );
    }

    case "ls":
      return executeCommand("ls", () => handleLsCommand({ stateDir }), io);

    case "tools": {
      const { selector, target, selectorOrTarget } = splitOptionalSelectorAndTarget(
        parsedArgs,
        "tools [selector] [name]",
      );

      return executeCommand(
        "tools",
        () =>
          handleToolsCommand(
            { selector: selector ?? selectorOrTarget, name: target },
            { stateDir },
          ),
        { ...io, full: Boolean(parsedOptions.full) },
      );
    }

    case "invoke": {
      const { selector, target: tool } = splitSelectorAndRequiredTarget(
        parsedArgs,
        "invoke [selector] <tool> --input '<json>'",
      );

      return executeCommand(
        "invoke",
        () =>
          handleInvokeCommand(
            {
              selector,
              tool,
              args: parseJsonInputOption(
                typeof parsedOptions.input === "string" ? parsedOptions.input : undefined,
              ),
              timeoutMs: parsePositiveIntegerOption(parsedOptions.timeout, "--timeout"),
            },
            { stateDir },
          ),
        io,
      );
    }

    case "revoke": {
      const { selector } = splitOptionalSelector(parsedArgs, "revoke [selector]");

      return executeCommand("revoke", () => handleRevokeCommand({ selector }, { stateDir }), io);
    }

    case "events": {
      const { selector } = splitOptionalSelector(parsedArgs, "events [selector]");

      return executeHostedCommand(
        "events",
        () =>
          handleEventsCommand(
            { selector },
            {
              stateDir,
              onEvent: (event: EventNotification) => {
                writers.stdout.write(`${renderEventLine(event, { json, color })}\n`);
              },
            },
          ),
        {
          ...io,
          reporter: {
            kind: "interactive",
            onEvent: () => {},
            dispose: () => {},
          },
        },
      );
    }

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
