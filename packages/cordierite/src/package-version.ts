/**
 * The single source of truth for "what version of Cordierite is this process running".
 *
 * The daemon (`daemon/daemon.ts`), the MCP server (`mcp/server.ts`), the CLI's `--version`
 * (`cli/create-cli.ts`) and the CLI's daemon version check (`cli/dispatch.ts`) all need the
 * published package version, and every one of them used to re-read `package.json` itself. They
 * read it through this module instead so a single mismatch in the relative path can't make one of
 * them report a different version than the others (issue #30).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test seam (issue #30): when set, the daemon reports this instead of the real package version in
 * `daemon.status` and the `daemon_started` event, so an integration test can produce a genuine
 * client/daemon version mismatch without installing two builds. Read only by the daemon — a
 * *client* must always report the version it truly is, or the check would compare a lie to a lie.
 */
export const DAEMON_VERSION_OVERRIDE_ENV = "CORDIERITE_DAEMON_VERSION_OVERRIDE";

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

let cached: string | undefined;

/** The `version` field of this package's `package.json`, read once per process. */
export const getPackageVersion = (): string => {
  cached ??= JSON.parse(readFileSync(packageJsonPath, "utf8")).version as string;
  return cached;
};

/**
 * The version the *daemon* reports over RPC: {@link getPackageVersion}, unless
 * {@link DAEMON_VERSION_OVERRIDE_ENV} overrides it. Evaluated per call (not cached) so a daemon
 * started in-process by a test picks up the environment that test set.
 */
export const getDaemonReportedVersion = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env[DAEMON_VERSION_OVERRIDE_ENV];
  return override !== undefined && override.length > 0 ? override : getPackageVersion();
};
