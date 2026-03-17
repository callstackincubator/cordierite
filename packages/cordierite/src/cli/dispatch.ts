import { handleConnectCommand } from "../commands/connect.js";
import { handleInvokeCommand } from "../commands/invoke.js";
import { handleSessionCommand } from "../commands/session.js";
import { handleToolsCommand } from "../commands/tools.js";
import { usageError } from "../errors.js";
import { systemClock } from "../runtime.js";
import { requireConnectPayload, requireSessionId, requireToolName } from "./command-options.js";
import { createCli } from "./create-cli.js";
import { executeCommand } from "./runner.js";
import { runHostSubcommand } from "./run-host.js";
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

  switch (matchedCommand) {
    case "host":
      return runHostSubcommand(parsedOptions, { json, color, writers, clock });

    case "connect":
      return executeCommand(
        "connect",
        () =>
          handleConnectCommand(
            {
              payload: requireConnectPayload(parsedOptions),
              requirePrivateIp: Boolean(parsedOptions.privateIp),
            },
            { clock },
          ),
        io,
      );

    case "session": {
      const rawSid = parsedOptions.sessionId;
      const sessionId =
        rawSid === undefined || rawSid === null
          ? undefined
          : typeof rawSid === "number" && Number.isFinite(rawSid)
            ? String(Math.trunc(rawSid))
            : typeof rawSid === "string" && rawSid.trim().length > 0
              ? rawSid.trim()
              : undefined;

      return executeCommand(
        "session",
        () =>
          handleSessionCommand({
            sessionId,
          }),
        io,
      );
    }

    case "tools":
      return executeCommand(
        "tools",
        () => {
          const name = parsedArgs[0];

          return handleToolsCommand({
            name: typeof name === "string" ? name : undefined,
            sessionId: requireSessionId(parsedOptions),
          });
        },
        io,
      );

    case "invoke":
      return executeCommand(
        "invoke",
        () => {
          const name = requireToolName(parsedArgs);
          const input = parsedOptions.input;

          return handleInvokeCommand({
            name,
            input: typeof input === "string" ? input : undefined,
            sessionId: requireSessionId(parsedOptions),
          });
        },
        io,
      );

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
