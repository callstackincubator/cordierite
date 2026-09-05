import type { EventNotification } from "@cordierite/shared";

import {
  handleDaemonRunCommand,
  handleDaemonStartCommand,
  handleDaemonStatusCommand,
  handleDaemonStopCommand,
} from "../commands/daemon.js";
import { handleDoctorCommand } from "../commands/doctor.js";
import { handleEventsCommand } from "../commands/events.js";
import { handleInvokeCommand } from "../commands/invoke.js";
import { handleKeygenCommand } from "../commands/keygen.js";
import { handleLinkCommand } from "../commands/link.js";
import { handleLsCommand } from "../commands/ls.js";
import { handleMcpCommand } from "../commands/mcp.js";
import { handleRevokeCommand } from "../commands/revoke.js";
import { handleToolsCommand } from "../commands/tools.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import { usageError } from "../errors.js";
import { renderEventLine, renderEventsCursorLine } from "../output.js";
import {
  parseJsonInputOption,
  parseNonNegativeIntegerOption,
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
    cli.parse(["node", "cordierite", ...argv], {
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
      return executeCommand(
        "link",
        () =>
          handleLinkCommand(
            {
              ttlSeconds: parsePositiveIntegerOption(parsedOptions.ttl, "--ttl"),
              scheme: typeof parsedOptions.scheme === "string" ? parsedOptions.scheme : undefined,
              open: typeof parsedOptions.open === "string" ? parsedOptions.open : undefined,
              device: typeof parsedOptions.device === "string" ? parsedOptions.device : undefined,
              // cac camelCases `--bundle-id`; the dashed spelling is kept as a fallback so a
              // parser change can't silently drop the flag.
              bundleId:
                typeof parsedOptions.bundleId === "string"
                  ? parsedOptions.bundleId
                  : typeof parsedOptions["bundle-id"] === "string"
                    ? parsedOptions["bundle-id"]
                    : undefined,
              // Left `undefined` when absent rather than coerced to `false`, so that
              // "--relaunch only applies with --open ios-device" fires on the flag actually being
              // passed and not on every `link` invocation.
              relaunch: parsedOptions.relaunch === true ? true : undefined,
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

      // SIGINT cancels the in-flight tools.call rather than leaving it running unowned in the app
      // (issue #9) — the listener is torn down once the command settles either way.
      const cancelController = new AbortController();
      const onSigint = (): void => cancelController.abort();
      process.once("SIGINT", onSigint);

      try {
        return await executeCommand(
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
              cancelController.signal,
            ),
          io,
        );
      } finally {
        process.off("SIGINT", onSigint);
      }
    }

    case "revoke": {
      const { selector } = splitOptionalSelector(parsedArgs, "revoke [selector]");

      return executeCommand("revoke", () => handleRevokeCommand({ selector }, { stateDir }), io);
    }

    case "events": {
      const { selector } = splitOptionalSelector(parsedArgs, "events [selector]");
      const since = parseNonNegativeIntegerOption(parsedOptions.since, "--since");
      const follow = Boolean(parsedOptions.follow);

      return executeHostedCommand(
        "events",
        () => {
          // Deferred into the wrapped handler (rather than thrown directly in this case body,
          // matching the codebase's existing lax convention for that) so `executeHostedCommand`'s
          // own try/catch renders it as a normal usage_error instead of an uncaught rejection.
          if (since !== undefined && follow) {
            throw usageError('"--since" is a one-shot pull and cannot be combined with "--follow".');
          }

          return handleEventsCommand(
            { selector, since },
            {
              stateDir,
              onEvent: (event: EventNotification) => {
                writers.stdout.write(`${renderEventLine(event, { json, color })}\n`);
              },
              onCursor: (cursor) => {
                writers.stdout.write(`${renderEventsCursorLine(cursor, { json, color })}\n`);
              },
            },
          );
        },
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

    case "mcp": {
      return executeHostedCommand(
        "mcp",
        () => handleMcpCommand({ stateDir }),
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

    case "doctor": {
      return executeCommand(
        "doctor",
        () =>
          handleDoctorCommand({
            artifactPath: parsedArgs[0],
            assertPresent: Boolean(parsedOptions.assertPresent),
            assertAbsent: Boolean(parsedOptions.assertAbsent),
          }),
        io,
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
