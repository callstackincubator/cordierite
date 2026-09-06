import type { EventNotification } from "@cordierite/shared";

import {
  handleDaemonRunCommand,
  handleDaemonStartCommand,
  handleDaemonStatusCommand,
  handleDaemonStopCommand,
} from "../commands/daemon.js";
import { handleDoctorCommand } from "../commands/doctor.js";
import { handleEventsCommand } from "../commands/events.js";
import { handleInitCommand } from "../commands/init.js";
import { handleInvokeCommand } from "../commands/invoke.js";
import { handleKeygenCommand } from "../commands/keygen.js";
import { handleLinkCommand } from "../commands/link.js";
import { handleLsCommand } from "../commands/ls.js";
import { handleMcpCommand } from "../commands/mcp.js";
import { handleRevokeCommand } from "../commands/revoke.js";
import { handleToolsCommand } from "../commands/tools.js";
import { loadConfig } from "../daemon/config.js";
import { getStateDirPaths, resolveStateDir } from "../daemon/state-dir.js";
import { usageError } from "../errors.js";
import { renderEventLine, renderEventsCursorLine } from "../output.js";
import { getPackageVersion } from "../package-version.js";
import { ensureDaemonVersionMatches, type VersionCheckOptions } from "../rpc/client.js";
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

/** `CORDIERITE_DAEMON_RESTART=1` forces a version-mismatch restart for one run — the env-var form
 * of `--daemon-restart`, so an MCP launch config (which passes no CLI flags) can opt in. */
const DAEMON_RESTART_ENV = "CORDIERITE_DAEMON_RESTART";

const isEnvTruthy = (value: string | undefined): boolean => {
  return value === "1" || value?.toLowerCase() === "true";
};

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

  // --- daemon/CLI version drift (issue #30, ARCHITECTURE.md §4 "Version drift") ------------------

  let forceRestart: Promise<boolean> | undefined;

  /** Memoized so the config read behind `restartDaemonOnVersionMismatch` happens at most once. */
  const resolveForceRestart = (): Promise<boolean> => {
    forceRestart ??= (async () => {
      let configuredForce = false;

      try {
        configuredForce = (await loadConfig(getStateDirPaths(stateDir))).restartDaemonOnVersionMismatch;
      } catch {
        // An unreadable/invalid `config.json` must not turn every command into a config error just
        // because one optional knob lives there; the daemon reports the real problem when it starts.
      }

      // An explicit flag wins outright, in both directions: `--no-daemon-restart` is how an
      // operator overrules a `restartDaemonOnVersionMismatch: true` in their config (or a
      // `CORDIERITE_DAEMON_RESTART` exported by a wrapper script) for one command, and silently
      // ignoring it would be the worst kind of surprise for a knob that decides whether their
      // connected devices survive.
      const flag = typeof parsedOptions.daemonRestart === "boolean" ? parsedOptions.daemonRestart : undefined;

      return flag ?? (isEnvTruthy(process.env[DAEMON_RESTART_ENV]) || configuredForce);
    })();

    return forceRestart;
  };

  /**
   * Where the "the running daemon is newer than this client" notice goes. `--json` promises one
   * machine-readable object and nothing else, so in that mode the notice is dropped rather than
   * dribbled onto stderr where it would corrupt a script that captures both streams — the check
   * still behaves identically, it just says nothing. (A structured warning channel would be the
   * better answer; the runner has none today.)
   */
  const cliWarning = json ? () => {} : (message: string) => void writers.stderr.write(message);

  const versionCheckFor = async (onWarning: (message: string) => void): Promise<VersionCheckOptions> => {
    return {
      clientVersion: getPackageVersion(),
      forceRestart: await resolveForceRestart(),
      onWarning,
    };
  };

  /**
   * Wraps a command handler so the daemon's version is verified once, before the command's first
   * RPC. `autoSpawn: false`: with nothing listening there is no drift to find, and any daemon this
   * process spawns afterwards is its own build. Applied to every command that talks to the daemon
   * except `daemon run` (it *is* the daemon), `daemon status` (warns instead — see
   * `commands/daemon.ts`) and `daemon stop` (already the remedy); `keygen`/`doctor` never open a
   * daemon connection at all.
   */
  const guarded = <T>(handler: () => T | Promise<T>): (() => Promise<T>) => {
    return async () => {
      await ensureDaemonVersionMatches({
        stateDir,
        autoSpawn: false,
        checkVersion: await versionCheckFor(cliWarning),
      });

      return handler();
    };
  };

  switch (matchedCommand) {
    case "init":
      return executeCommand(
        "init",
        () =>
          handleInitCommand(
            {
              scheme: typeof parsedOptions.scheme === "string" ? parsedOptions.scheme : undefined,
              force: Boolean(parsedOptions.force),
            },
            // `init` never reads the state dir, but it must know which directory it is so it can
            // refuse to write a "safe to commit" project config into the daemon's own state.
            { stateDir },
          ),
        io,
      );

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
        guarded(() =>
          handleLinkCommand(
            {
              ttlSeconds: parsePositiveIntegerOption(parsedOptions.ttl, "--ttl"),
              scheme: typeof parsedOptions.scheme === "string" ? parsedOptions.scheme : undefined,
              open: typeof parsedOptions.open === "string" ? parsedOptions.open : undefined,
              device: typeof parsedOptions.device === "string" ? parsedOptions.device : undefined,
            },
            { stateDir },
          ),
        ),
        {
          ...io,
          qr: Boolean(parsedOptions.qr),
        },
      );
    }

    case "ls":
      return executeCommand("ls", guarded(() => handleLsCommand({ stateDir })), io);

    case "tools": {
      const { selector, target, selectorOrTarget } = splitOptionalSelectorAndTarget(
        parsedArgs,
        "tools [selector] [name]",
      );

      return executeCommand(
        "tools",
        guarded(() =>
          handleToolsCommand(
            { selector: selector ?? selectorOrTarget, name: target },
            { stateDir },
          ),
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
          guarded(() =>
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
          ),
          io,
        );
      } finally {
        process.off("SIGINT", onSigint);
      }
    }

    case "revoke": {
      const { selector } = splitOptionalSelector(parsedArgs, "revoke [selector]");

      return executeCommand(
        "revoke",
        guarded(() => handleRevokeCommand({ selector }, { stateDir })),
        io,
      );
    }

    case "events": {
      const { selector } = splitOptionalSelector(parsedArgs, "events [selector]");
      const since = parseNonNegativeIntegerOption(parsedOptions.since, "--since");
      const follow = Boolean(parsedOptions.follow);

      return executeHostedCommand(
        "events",
        guarded(() => {
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
        }),
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
        // Unlike every other command the check is threaded into the server itself, not run ahead
        // of it: the MCP server is long-lived and auto-spawns its own daemon, so the check belongs
        // on the startup stream that establishes the connection it keeps (ARCHITECTURE.md §9).
        // The notice always goes to stderr here, `--json` or not: stdout carries MCP protocol
        // frames, and stderr is this server's only log channel (ARCHITECTURE.md §9).
        async () =>
          handleMcpCommand({
            stateDir,
            scheme: typeof parsedOptions.scheme === "string" ? parsedOptions.scheme : undefined,
            checkVersion: await versionCheckFor((message) => void writers.stderr.write(message)),
          }),
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
          return executeCommand(
            "daemon start",
            guarded(() => handleDaemonStartCommand({ stateDir, clock })),
            io,
          );

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
