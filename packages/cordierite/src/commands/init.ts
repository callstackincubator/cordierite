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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
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

  // `--scheme` beats discovery so a project with a dynamic Expo config (`app.config.js`, which is
  // never executed — see `scheme.ts`) can still be initialized in a single command.
  const discovered = options.scheme ?? (await discoverExpoScheme(root));

  const existing = await readExistingConfig(configPath);
  const existingScheme = typeof existing?.scheme === "string" ? existing.scheme : undefined;
  const scheme = discovered ?? existingScheme;

  if (scheme === undefined) {
    throw usageError(
      `No deep-link scheme found for ${root}: ${join(root, APP_JSON_FILENAME)} declares no ` +
        '"expo.scheme", and none was given. Run `cordierite init --scheme <scheme>` with the ' +
        'scheme your app registers for deep links (e.g. "myapp"), or add "expo.scheme" to ' +
        `${APP_JSON_FILENAME} first.`,
    );
  }

  if (existingScheme !== undefined && existingScheme !== scheme && !options.force) {
    throw usageError(
      `${configPath} already records the scheme "${existingScheme}", but ${
        options.scheme === undefined
          ? `${join(root, APP_JSON_FILENAME)} now declares "${scheme}"`
          : `--scheme asked for "${scheme}"`
      }. Re-run with --force to replace it (every other key in the file is preserved), or leave ` +
        "the project config as it is.",
    );
  }

  const alreadyCorrect = existingScheme === scheme;

  if (!alreadyCorrect) {
    // Merge rather than replace: `--force` changes the scheme, it does not reset the file.
    const next = { ...(existing ?? {}), scheme };

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return {
    ok: true,
    data: {
      path: configPath,
      scheme,
      source:
        options.scheme !== undefined
          ? "flag"
          : discovered !== undefined
            ? "app.json"
            : "project-config",
      created: existing === undefined,
      changed: !alreadyCorrect,
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
      ],
    },
  };
};
