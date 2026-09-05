/**
 * Deep-link scheme resolution (ARCHITECTURE.md §10, issue #29).
 *
 * A scheme is needed to compose `<scheme>:///?cordierite=<payload>` in `cordierite link`,
 * `cordierite/client`'s `link()` and the MCP `cordierite_connect` tool. Before this module the only
 * source was `<state-dir>/config.json` — a single global file, which meant two apps with different
 * schemes on one machine required hand-editing it on every switch.
 *
 * The resolution order below is shared by every one of those callers so it cannot drift, first
 * match wins:
 *
 *   1. an explicit flag/option (`--scheme`)
 *   2. the `CORDIERITE_SCHEME` environment variable
 *   3. the nearest `.cordierite/config.json`, walking up from the working directory
 *   4. `scheme` in the state directory's `config.json` (the pre-#29 behaviour)
 *   5. `<cwd>/app.json`'s `expo.scheme` (no walk-up — an app root is where you run these commands)
 *
 * Nothing here executes project code: `app.config.js`/`app.config.ts` are deliberately *not*
 * evaluated (running arbitrary project JS to read one string is a much larger blast radius than
 * this feature warrants). Dynamic-config projects use `--scheme`, `CORDIERITE_SCHEME`, or a
 * project `.cordierite/config.json` instead.
 *
 * A project `.cordierite/config.json` carries client-side keys only (`scheme` today). It never
 * redirects the state directory — `--state-dir` / `CORDIERITE_STATE_DIR` remain the only way to do
 * that — so a project file can never move the daemon's key, socket or audit log.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { usageError } from "./errors.js";

/** The directory a project-level config lives in, relative to an app root. */
export const PROJECT_CONFIG_DIR = ".cordierite";

/** The project-level config filename, inside {@link PROJECT_CONFIG_DIR}. */
export const PROJECT_CONFIG_FILENAME = "config.json";

/** Relative path used in messages/docs: `.cordierite/config.json`. */
export const PROJECT_CONFIG_RELATIVE_PATH = join(PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);

/** The Expo app manifest discovery reads. Only static JSON — see this module's doc comment. */
export const APP_JSON_FILENAME = "app.json";

export const SCHEME_ENV_VAR = "CORDIERITE_SCHEME";

/**
 * RFC 3986 §3.1 scheme grammar: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`.
 *
 * Enforced so a value like `"myapp://"` (a very natural thing to paste into `--scheme`) fails with
 * a message naming the offending source instead of silently composing the unopenable
 * `myapp://:///?cordierite=…`.
 */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*$/u;

export const isValidScheme = (value: string): boolean => SCHEME_PATTERN.test(value);

/** Which step of the order above produced the scheme. */
export type SchemeSource = "flag" | "env" | "project-config" | "state-config" | "app-json";

export type ResolvedScheme = {
  /** Undefined when no source produced one; `tried` then explains where we looked. */
  scheme?: string;
  source?: SchemeSource;
  /** Human-readable descriptions of every location consulted, in order, for error messages. */
  tried: string[];
};

const requireValidScheme = (value: string, origin: string): string => {
  if (!isValidScheme(value)) {
    throw usageError(
      `Invalid deep-link scheme ${JSON.stringify(value)} from ${origin}: a scheme must start with ` +
        'a letter and contain only letters, digits, "+", "-" or "." (for example "myapp") — do not ' +
        'include "://".',
    );
  }

  return value;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/** Reads and JSON-parses a file; `undefined` when it does not exist. Other I/O errors propagate. */
const readJsonFile = async (path: string): Promise<{ raw: unknown } | undefined> => {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    // A `.cordierite` that is a file, or an `app.json` that is a directory, is "nothing usable
    // here" rather than a hard failure — the caller falls through to the next source.
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      return undefined;
    }

    throw error;
  }

  try {
    return { raw: JSON.parse(text) as unknown };
  } catch (error) {
    throw usageError(`Could not parse ${path}: ${(error as Error).message}`);
  }
};

/**
 * Normalizes Expo's `scheme` field, which is either a single string or an array of them. Mirrors
 * `packages/react-native/app.plugin.js`'s `configuredSchemes` so the CLI and the config plugin
 * agree on what "the app's scheme" means; the first entry wins for an array.
 */
const firstConfiguredScheme = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }

  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Reads `<dir>/app.json`'s `expo.scheme`. Returns `undefined` when the file is missing, is not a
 * JSON object, has no `expo` object, or declares no usable scheme — every one of which just means
 * "discovery found nothing here". A *malformed* `app.json` throws, because silently ignoring a
 * syntax error in the file the user is pointing us at reads as "Cordierite ignored my config".
 */
export const discoverExpoScheme = async (dir: string): Promise<string | undefined> => {
  const path = join(resolve(dir), APP_JSON_FILENAME);
  const file = await readJsonFile(path);

  if (!file || !isPlainObject(file.raw)) {
    return undefined;
  }

  const expo = file.raw.expo;

  if (!isPlainObject(expo)) {
    return undefined;
  }

  const scheme = firstConfiguredScheme(expo.scheme);

  return scheme === undefined ? undefined : requireValidScheme(scheme, `"expo.scheme" in ${path}`);
};

/**
 * Walks up from `startDir` looking for `<dir>/.cordierite/config.json`, returning the nearest one.
 *
 * The walk terminates at the filesystem root (`dirname("/") === "/"`, and likewise for a Windows
 * drive root) — it cannot escape above it, and it never follows `..` out of a caller-supplied
 * path because every candidate is derived from the resolved absolute `startDir`.
 *
 * `stateDirRoot`, when given, is skipped: with the default `~/.cordierite` state dir, *any* cwd
 * under the home directory would otherwise find the global config during the walk-up and report it
 * as a project config — and worse, with `--state-dir` pointing elsewhere it would silently apply
 * the unrelated global file as if it were the project's.
 */
export const findProjectConfig = (startDir: string, stateDirRoot?: string): string | undefined => {
  const stateRoot = stateDirRoot === undefined ? undefined : resolve(stateDirRoot);
  let dir = resolve(startDir);

  for (;;) {
    const projectDir = join(dir, PROJECT_CONFIG_DIR);

    if (stateRoot === undefined || projectDir !== stateRoot) {
      const candidate = join(projectDir, PROJECT_CONFIG_FILENAME);

      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = dirname(dir);

    if (parent === dir) {
      return undefined;
    }

    dir = parent;
  }
};

/**
 * Reads the `scheme` key out of a project `.cordierite/config.json`. Unlike `app.json` this *is*
 * Cordierite's own file, so anything wrong with it (not an object, `scheme` not a non-empty
 * string) is a hard error rather than a silent fall-through — a typo here must not quietly
 * degrade to a different scheme from a lower-precedence source.
 *
 * Keys other than `scheme` are ignored: a project file is client-side settings only, and
 * accepting (say) `keyPath` here would let a checked-in file redirect the daemon's key material.
 */
export const readProjectConfigScheme = async (path: string): Promise<string | undefined> => {
  const file = await readJsonFile(path);

  if (!file) {
    return undefined;
  }

  if (!isPlainObject(file.raw)) {
    throw usageError(`Invalid Cordierite project config at ${path}: must be a JSON object.`);
  }

  const scheme = file.raw.scheme;

  if (scheme === undefined) {
    return undefined;
  }

  if (typeof scheme !== "string" || scheme.length === 0) {
    throw usageError(
      `Invalid Cordierite project config at ${path}: "scheme" must be a non-empty string.`,
    );
  }

  return requireValidScheme(scheme, `"scheme" in ${path}`);
};

export type ResolveSchemeOptions = {
  /** `--scheme` (or a programmatic `scheme` option) — highest precedence. */
  flagScheme?: string;
  /** Defaults to `process.env`; the `CORDIERITE_SCHEME` entry is what is read. */
  env?: NodeJS.ProcessEnv;
  /** Where the project walk-up and `app.json` discovery start. Defaults to `process.cwd()`. */
  cwd?: string;
  /** `scheme` already loaded from the state directory's `config.json`. */
  configScheme?: string;
  /** The state directory's `config.json` path, named in `tried` (and used to skip it in the walk-up). */
  stateConfigPath?: string;
  /** The state directory root, so the walk-up never mistakes it for a project config. */
  stateDirRoot?: string;
};

/**
 * Resolves the deep-link scheme against the documented order, reporting both the winner and every
 * location consulted so callers can render an error that says where to put one.
 */
export const resolveScheme = async (options: ResolveSchemeOptions = {}): Promise<ResolvedScheme> => {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const tried: string[] = [];

  tried.push("the --scheme flag");

  if (options.flagScheme !== undefined && options.flagScheme.length > 0) {
    return {
      scheme: requireValidScheme(options.flagScheme, "the --scheme flag"),
      source: "flag",
      tried,
    };
  }

  tried.push(`the ${SCHEME_ENV_VAR} environment variable`);

  const envScheme = env[SCHEME_ENV_VAR];

  if (typeof envScheme === "string" && envScheme.length > 0) {
    return {
      scheme: requireValidScheme(envScheme, `the ${SCHEME_ENV_VAR} environment variable`),
      source: "env",
      tried,
    };
  }

  const projectConfigPath = findProjectConfig(cwd, options.stateDirRoot);

  tried.push(
    projectConfigPath === undefined
      ? `${PROJECT_CONFIG_RELATIVE_PATH} (searched upwards from ${cwd})`
      : projectConfigPath,
  );

  if (projectConfigPath !== undefined) {
    const projectScheme = await readProjectConfigScheme(projectConfigPath);

    if (projectScheme !== undefined) {
      return { scheme: projectScheme, source: "project-config", tried };
    }
  }

  tried.push(
    options.stateConfigPath === undefined
      ? 'the state directory\'s config.json ("scheme")'
      : `${options.stateConfigPath} ("scheme")`,
  );

  if (options.configScheme !== undefined && options.configScheme.length > 0) {
    return {
      scheme: requireValidScheme(
        options.configScheme,
        options.stateConfigPath === undefined
          ? 'the state directory\'s config.json "scheme"'
          : `"scheme" in ${options.stateConfigPath}`,
      ),
      source: "state-config",
      tried,
    };
  }

  tried.push(`${join(cwd, APP_JSON_FILENAME)} ("expo.scheme")`);

  const appJsonScheme = await discoverExpoScheme(cwd);

  if (appJsonScheme !== undefined) {
    return { scheme: appJsonScheme, source: "app-json", tried };
  }

  return { tried };
};

/**
 * The shared "no scheme anywhere" message. Every caller renders the same body so the locations
 * listed (and the fixes suggested) can't drift between `cordierite link`, `cordierite mcp` and
 * `cordierite_connect`.
 */
export const describeMissingScheme = (tried: string[]): string => {
  const locations =
    tried.length === 0
      ? ""
      : `Looked in, in order:\n${tried
          .map((location, index) => `  ${index + 1}. ${location}`)
          .join("\n")}\n`;

  return (
    "A deep-link scheme is required to compose the link, and none was found. " +
    locations +
    `Set one with --scheme <scheme>, ${SCHEME_ENV_VAR}=<scheme>, "expo.scheme" in ${APP_JSON_FILENAME}, ` +
    `or run \`cordierite init\` in your app root to write ${PROJECT_CONFIG_RELATIVE_PATH}.`
  );
};

/** {@link resolveScheme}, throwing {@link usageError} with {@link describeMissingScheme} when nothing matched. */
export const resolveSchemeOrThrow = async (options: ResolveSchemeOptions = {}): Promise<string> => {
  const resolved = await resolveScheme(options);

  if (resolved.scheme === undefined) {
    throw usageError(describeMissingScheme(resolved.tried));
  }

  return resolved.scheme;
};
