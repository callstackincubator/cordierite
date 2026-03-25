import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cac } from "cac";

const version: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
).version;

export const createCli = () => {
  const cli = cac("cordierite");

  cli.option("--json", "Print one final machine-readable JSON result.");
  cli.option("--no-color", "Disable terminal color in human-readable output.");

  cli
    .command("host", "Start a local Cordierite WSS host for the Expo app.")
    .option("--tls-key <path>", "Path to the PEM private key used to generate the host certificate.")
    .option("--ip <ip>", "Local IPv4 address to advertise in the bootstrap payload.")
    .option("--port <port>", "Local port to listen on.", {
      default: 8443,
    })
    .option("--ttl <seconds>", "How long the pending session stays claimable.", {
      default: 30,
    })
    .option("--scheme <scheme>", "App URL scheme to open (required).")

  cli
    .command("connect")
    .option("--payload <payload>", "Bootstrap payload: base64url binary v1 (`p` query value).")
    .option("--private-ip", "Require a private IPv4 bootstrap endpoint.");

  cli.command("keygen", "Generate a Cordierite host private key and its app fingerprint.");

  cli
    .command("session", "List Cordierite host sessions or inspect one with --session-id.")
    .option("--session-id <id>", "Opaque session id from `host` JSON (`host.session_id`).");

  cli
    .command("tools [name]", "List tools from the connected device or inspect one tool.")
    .option("--session-id <id>", "Opaque session id from `host` JSON. Required.");

  cli
    .command("invoke <name>", "Invoke a device tool with JSON input.")
    .option("--session-id <id>", "Opaque session id from `host` JSON. Required.")
    .option("--input <json>", "JSON object passed to the tool as args.");

  cli.help();
  cli.version(version);

  return cli;
};
