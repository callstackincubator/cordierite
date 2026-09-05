import { cac } from "cac";

import { getPackageVersion } from "../package-version.js";

export const createCli = () => {
  const version = getPackageVersion();
  const cli = cac("cordierite");

  cli.option("--json", "Print machine-readable JSON (NDJSON for streaming commands).");
  cli.option("--no-color", "Disable terminal color in human-readable output.");
  cli.option("--state-dir <path>", "Override the Cordierite state directory (default: ~/.cordierite).");
  cli.option(
    "--daemon-restart",
    "On a daemon/CLI version mismatch, restart the daemon even though that drops live sessions.",
  );

  cli
    .command("keygen", "Generate a Cordierite host private key and print its app fingerprint.")
    .option("--out <path>", "Destination path (default: <state-dir>/key.pem).")
    .option("--force", "Overwrite an existing key at the destination path.");

  cli
    .command("link", "Mint a pending session and print its deep link.")
    .option("--ttl <seconds>", "Link time-to-live in seconds (default: from config.json).")
    .option("--qr", "Also render the deep link as a terminal QR code.")
    .option("--scheme <scheme>", "Deep-link URI scheme (default: config.json's \"scheme\").")
    .option("--open <target>", "Deliver the link automatically via adb/simctl (android|ios-sim).")
    .option("--device <id>", "adb serial or simulator udid to target when --open is ambiguous.");

  cli.command("ls", "List Cordierite sessions.");

  cli
    .command("tools [selector] [name]", "List a session's tools, or show one tool's full schema.")
    .option("--full", "Render full schemas/annotations for every listed tool.");

  cli
    .command("invoke [selector] [tool]", "Call a tool on a session.")
    .option("--input <json>", "Tool input arguments as a JSON object.")
    .option(
      "--timeout <ms>",
      "Call timeout in milliseconds. Shortens the deadline; it cannot extend one past the app's " +
        "own timer, which is the tool's declared timeoutMs (else 10000).",
    );

  cli
    .command("events [selector]", "Stream session/tool events until interrupted.")
    .option("--follow", "Accepted for script readability; the default behavior already follows.")
    .option("--since <cursor>", "One-shot: print events retained since this cursor instead of streaming live.");

  cli.command("revoke [selector]", "Revoke a session.");

  cli.command("mcp", "Start a stdio MCP server that proxies connected apps' tools to MCP clients.");

  cli
    .command("doctor <artifact>", "Report (or assert) whether a built .app/.ipa/.apk/.aab contains Cordierite.")
    .option("--assert-present", "Exit non-zero (and report) if Cordierite is not present in the artifact.")
    .option("--assert-absent", "Exit non-zero (and report) if Cordierite is present in the artifact.");

  // cac only matches a command's first word against argv[0], so "run"/"start"/"stop"/"status"
  // are handled as a sub-action of the single "daemon" command rather than four cac commands.
  cli.command("daemon [action]", "Manage the Cordierite daemon: run, start, stop, or status.");

  cli.help();
  cli.version(version);

  return cli;
};
