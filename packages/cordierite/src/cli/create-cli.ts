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

  cli.command("keygen", "Generate a Cordierite host private key and its app fingerprint.");

  // cac only matches a command's first word against argv[0], so "run"/"start"/"stop"/"status"
  // are handled as a sub-action of the single "daemon" command rather than four cac commands.
  cli.command("daemon [action]", "Manage the Cordierite daemon: run, start, stop, or status.");

  cli.help();
  cli.version(version);

  return cli;
};
