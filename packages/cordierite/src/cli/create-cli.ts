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

  cli.help();
  cli.version(version);

  return cli;
};
