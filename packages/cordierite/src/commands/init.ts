/**
 * `cordierite init` (issue #29): the one command that takes an app root from "package installed"
 * to "an agent can connect".
 *
 * It writes a *project-level* `.cordierite/config.json` holding the deep-link scheme, and returns
 * the two things that are not discoverable from the filesystem: the MCP server entry to paste into
 * an agent's config, and the `import "@cordierite/react-native/auto"` reminder the app needs.
 *
 * What it deliberately does **not** do:
 *
 * - It never generates or touches key material. The daemon auto-generates a host key at startup
 *   (`daemon/tls.ts`), so making `init` a key-generating step would re-introduce exactly the
 *   "run keygen, paste a pin" ceremony this command exists to remove. `cordierite keygen` remains
 *   for explicit rotation/provisioning.
 * - It never writes daemon-side settings (`wssPort`, `keyPath`, `policy`, ...), and the project
 *   file is never *read* for them either (`scheme.ts`). A project config that could redirect
 *   `keyPath` would mean a file checked into a repo could move another developer's private key.
 * - It never starts, stops or contacts the daemon.
 *
 * Idempotency (issue #29's acceptance criterion): re-running with the same scheme is a no-op that
 * still prints the snippet, a *different* scheme is refused unless `--force`, and `--force` merges
 * into the existing JSON rather than truncating it, so a key a future version adds is not silently
 * dropped by an old binary.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { CliResult, InitCommandData } from "../cli/result-types.js";
import { usageError } from "../errors.js";
import {
  APP_JSON_FILENAME,
  discoverExpoScheme,
  isValidScheme,
  PROJECT_CONFIG_DIR,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_RELATIVE_PATH,
  SCHEME_ENV_VAR,
} from "../scheme.js";

export type InitCommandOptions = {
  scheme?: string;
  force?: boolean;
};

export type InitCommandContext = {
  /** The app root to initialize. Defaults to `process.cwd()`. */
  cwd?: string;
};

const readExistingConfig = async (path: string): Promise<Record<string, unknown> | undefined> => {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return undefined;
    }

    // `.cordierite` is a regular file (ENOTDIR), or `config.json` is a directory (EISDIR). Both
    // are things a person did to their own project, so they get a usage error naming the path —
    // not a raw errno from `readFile` rendered as an internal failure.
    if (code === "ENOTDIR") {
      throw usageError(
        `Cannot write ${path}: a file already exists where the "${PROJECT_CONFIG_DIR}" directory ` +
          "needs to go. Remove or rename it, then re-run `cordierite init`.",
      );
    }

    if (code === "EISDIR") {
      throw usageError(
        `Cannot write ${path}: it is a directory, not a file. Remove it, then re-run \`cordierite init\`.`,
      );
    }

    throw error;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw usageError(
      `Could not parse the existing ${path}: ${(error as Error).message}. Fix or delete it, then re-run \`cordierite init\`.`,
    );
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw usageError(
      `The existing ${path} is not a JSON object. Fix or delete it, then re-run \`cordierite init\`.`,
    );
  }

  return raw as Record<string, unknown>;
};

/**
 * The `scheme` already recorded in the project config, validated.
 *
 * A hand-edited `"scheme": "myapp://"` must not be adopted and echoed back into `mcpServerEntry`
 * as though it were usable — every consumer of that entry would compose an unopenable link, and
 * `cordierite link` would reject the very value `init` just blessed.
 */
const readExistingScheme = (
  existing: Record<string, unknown> | undefined,
  path: string,
): string | undefined => {
  const scheme = existing?.scheme;

  if (scheme === undefined) {
    return undefined;
  }

  if (typeof scheme !== "string" || !isValidScheme(scheme)) {
    throw usageError(
      `${path} records an invalid deep-link scheme ${JSON.stringify(scheme)}: a scheme must start ` +
        'with a letter and contain only letters, digits, "+", "-" or "." (for example "myapp") — ' +
        'do not include "://". Fix it, or re-run with --scheme <scheme> --force.',
    );
  }

  return scheme;
};

export const handleInitCommand = async (
  options: InitCommandOptions,
  context: InitCommandContext = {},
): Promise<CliResult<InitCommandData>> => {
  const root = resolve(context.cwd ?? process.cwd());
  const configPath = join(root, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);

  if (options.scheme !== undefined && !isValidScheme(options.scheme)) {
    throw usageError(
      `Invalid deep-link scheme ${JSON.stringify(options.scheme)} from --scheme: a scheme must ` +
        'start with a letter and contain only letters, digits, "+", "-" or "." (for example ' +
        '"myapp") — do not include "://".',
    );
  }

  const existing = await readExistingConfig(configPath);
  const existingScheme = readExistingScheme(existing, configPath);
  const appJsonScheme = await discoverExpoScheme(root);

  /*
   * Which scheme wins, and when that is an error, is the whole idempotency contract:
   *
   * - `--scheme` always wins, but replacing a *different* recorded scheme needs `--force`, since
   *   that is a person asking for one thing while the file already says another.
   * - A plain re-run keeps whatever is already recorded, even when `app.json` has since changed.
   *   Erroring there would mean `cordierite init` — documented as safe to re-run — starts failing
   *   because somebody renamed a scheme in `app.json`. The divergence is reported as a `note`
   *   instead: visible, but not fatal.
   * - `--force` on its own is the escape hatch that re-adopts discovery, replacing the recorded
   *   scheme with `app.json`'s.
   * - With nothing recorded, `app.json` decides.
   */
  const [scheme, source] = ((): [string | undefined, InitCommandData["source"]] => {
    if (options.scheme !== undefined) {
      return [options.scheme, "flag"];
    }

    if (options.force && appJsonScheme !== undefined) {
      return [appJsonScheme, "app.json"];
    }

    return existingScheme === undefined ? [appJsonScheme, "app.json"] : [existingScheme, "project-config"];
  })();

  if (scheme === undefined) {
    throw usageError(
      `No deep-link scheme found for ${root}: ${join(root, APP_JSON_FILENAME)} declares no ` +
        '"expo.scheme", and none was given. Run `cordierite init --scheme <scheme>` with the ' +
        'scheme your app registers for deep links (e.g. "myapp"), or add "expo.scheme" to ' +
        `${APP_JSON_FILENAME} first.`,
    );
  }

  if (
    options.scheme !== undefined &&
    existingScheme !== undefined &&
    existingScheme !== options.scheme &&
    !options.force
  ) {
    throw usageError(
      `${configPath} already records the scheme "${existingScheme}", but --scheme asked for ` +
        `"${options.scheme}". Re-run with --force to replace it (every other key in the file is ` +
        "preserved), or drop --scheme to keep what is recorded.",
    );
  }

  // Only when the recorded scheme is the one being kept *and* app.json disagrees. After `--force`
  // (or an explicit `--scheme`) has resolved the divergence there is nothing left to report.
  const note =
    scheme === existingScheme && appJsonScheme !== undefined && appJsonScheme !== scheme
      ? `${join(root, APP_JSON_FILENAME)} declares "${appJsonScheme}", but ${configPath} records ` +
        `"${existingScheme}", which is what Cordierite uses. Run \`cordierite init --force\` to ` +
        "adopt the app.json value instead."
      : undefined;

  const alreadyCorrect = existingScheme === scheme;

  if (!alreadyCorrect) {
    // Merge rather than replace: `--force` changes the scheme, it does not reset the file.
    const next = { ...(existing ?? {}), scheme };

    // Mode 0700/0600, matching the state directory's conventions (ARCHITECTURE.md §3). This file
    // holds no secret today, but a directory named `.cordierite` is exactly where a later key or
    // token would land, and a world-readable default would be the wrong thing to have established.
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  return {
    ok: true,
    data: {
      path: configPath,
      scheme,
      source,
      created: existing === undefined,
      changed: !alreadyCorrect,
      ...(note === undefined ? {} : { note }),
      mcpServerEntry: {
        command: "cordierite",
        args: ["mcp", "--scheme", scheme],
      },
      nextSteps: [
        'Add `import "@cordierite/react-native/auto";` to your app entry (index.js / App.tsx) — it ' +
          "is what starts the in-app agent endpoint.",
        `Add the Cordierite MCP server entry to your agent's MCP config. "--scheme ${scheme}" keeps it ` +
          `entry self-contained; ${SCHEME_ENV_VAR} and this ${PROJECT_CONFIG_RELATIVE_PATH} work too.`,
        "With the app running, pair a device: `cordierite link --open ios-sim` (or `--open android`).",
        `This file is safe to commit — it holds only "scheme". Do not point --state-dir at this ` +
          "directory: the state dir holds the daemon's private key and audit log, which must " +
          "never be committed.",
      ],
    },
  };
};
