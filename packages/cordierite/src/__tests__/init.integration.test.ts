/**
 * `cordierite init` (issue #29): the project-level setup command, exercised both directly
 * (`commands/init.ts`) and through the real CLI binary in a temporary app root, since its whole
 * value is what it does to a directory a user is standing in.
 *
 * The idempotency criterion from the issue — "`cordierite init` is idempotent and covered by a CLI
 * integration test" — is the `re-running` cases below.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { handleInitCommand } from "../commands/init.js";
import { runCliBinary } from "./fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { force: true, recursive: true });
  }
});

/** A throwaway app root, optionally with an `app.json` declaring `expo.scheme`. */
const makeAppRoot = async (expoScheme?: unknown): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "cordierite-init-"));
  directories.push(root);

  if (expoScheme !== undefined) {
    await writeFile(
      path.join(root, "app.json"),
      JSON.stringify({ expo: { name: "Demo", scheme: expoScheme } }),
      "utf8",
    );
  }

  return root;
};

const projectConfigPath = (root: string): string => path.join(root, ".cordierite", "config.json");

const readProjectConfig = async (root: string): Promise<Record<string, unknown>> => {
  return JSON.parse(await readFile(projectConfigPath(root), "utf8")) as Record<string, unknown>;
};

/** Writes a project config directly, bypassing `init` — for the hand-edited-file cases. */
const writeProjectConfigRaw = async (root: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(projectConfigPath(root)), { recursive: true });
  await writeFile(projectConfigPath(root), JSON.stringify(value), "utf8");
};

/** A state dir the CLI can safely use, so `init` runs never touch the developer's `~/.cordierite`. */
const makeStateDir = async (): Promise<string> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-init-state-"));
  directories.push(stateDir);

  return stateDir;
};

describe("init command", () => {
  test("writes the scheme discovered from app.json", async () => {
    const root = await makeAppRoot("myapp");

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: projectConfigPath(root),
        scheme: "myapp",
        source: "app.json",
        created: true,
        changed: true,
        mcpServerEntry: { command: "cordierite", args: ["mcp", "--scheme", "myapp"] },
      },
    });
    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("takes the first entry of an array expo.scheme", async () => {
    const root = await makeAppRoot(["myapp", "myapp-dev"]);

    await handleInitCommand({}, { cwd: root });

    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("--scheme beats app.json, for projects with a dynamic app.config.js", async () => {
    const root = await makeAppRoot("from-app-json");

    const result = await handleInitCommand({ scheme: "from-flag" }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "from-flag", source: "--scheme" } });
    expect(await readProjectConfig(root)).toEqual({ scheme: "from-flag" });
  });

  test("re-running with the same scheme is a no-op that still reports the snippet", async () => {
    const root = await makeAppRoot("myapp");

    await handleInitCommand({}, { cwd: root });
    const before = await stat(projectConfigPath(root));

    const second = await handleInitCommand({}, { cwd: root });

    expect(second).toMatchObject({
      ok: true,
      data: {
        scheme: "myapp",
        created: false,
        changed: false,
        mcpServerEntry: { args: ["mcp", "--scheme", "myapp"] },
      },
    });
    // Not merely "the content is the same": the file was never rewritten.
    expect((await stat(projectConfigPath(root))).mtimeMs).toBe(before.mtimeMs);
  });

  test("refuses a different scheme without --force", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({}, { cwd: root });

    await expect(handleInitCommand({ scheme: "other" }, { cwd: root })).rejects.toThrow(
      /already records the scheme "myapp"/u,
    );
    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  // A plain re-run must stay idempotent even after `app.json` is edited: `cordierite init` is
  // documented as safe to re-run, so renaming a scheme in `app.json` must not start breaking it.
  // The divergence is surfaced as a note, not an error.
  test("keeps the recorded scheme and notes the divergence when app.json changed underneath", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({}, { cwd: root });

    await writeFile(
      path.join(root, "app.json"),
      JSON.stringify({ expo: { scheme: "renamed" } }),
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: { scheme: "myapp", source: "already-recorded", changed: false },
    });
    expect(result.ok && result.data.note).toMatch(/renamed[\s\S]*myapp/u);
    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("--scheme --force adopts the new app.json value the note points at", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({}, { cwd: root });

    const result = await handleInitCommand({ scheme: "renamed", force: true }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "renamed", changed: true } });
    expect(result.ok && result.data.note).toBeUndefined();
  });

  // `--force` on its own is the escape hatch the note tells you to run, so it must both adopt the
  // app.json value and stop reporting a divergence that no longer exists.
  test("--force alone re-adopts app.json and clears the note", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({}, { cwd: root });

    await writeFile(
      path.join(root, "app.json"),
      JSON.stringify({ expo: { scheme: "renamed" } }),
      "utf8",
    );

    const result = await handleInitCommand({ force: true }, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: { scheme: "renamed", source: "app.json", changed: true },
    });
    expect(result.ok && result.data.note).toBeUndefined();
    expect(await readProjectConfig(root)).toEqual({ scheme: "renamed" });
  });

  test("rejects an invalid scheme recorded by hand instead of echoing it into the MCP entry", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "myapp://" });

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(
      /records an invalid deep-link scheme/u,
    );
  });

  // The error above suggests `--scheme <s> --force`; that remedy has to actually work, rather than
  // hitting the same validation and reproducing the error it was offered to fix.
  test("--scheme --force replaces an invalid recorded scheme rather than failing on it", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "myapp://", keepMe: 1 });

    const result = await handleInitCommand({ scheme: "good", force: true }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "good", source: "--scheme" } });
    expect(await readProjectConfig(root)).toEqual({ scheme: "good", keepMe: 1 });
  });

  test("--force alone replaces an invalid recorded scheme with app.json's", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "myapp://" });

    const result = await handleInitCommand({ force: true }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "myapp", source: "app.json" } });
  });

  test("--scheme alone replaces an invalid recorded scheme — there is nothing to protect", async () => {
    const root = await makeAppRoot();
    await writeProjectConfigRaw(root, { scheme: "myapp://" });

    const result = await handleInitCommand({ scheme: "good" }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "good" } });
  });

  test("reports a usage error when .cordierite is a file, not a directory", async () => {
    const root = await makeAppRoot("myapp");
    await writeFile(path.join(root, ".cordierite"), "not a directory", "utf8");

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(
      /a file already exists where the "\.cordierite" directory needs to go/u,
    );
  });

  test("reports a usage error when config.json is a directory", async () => {
    const root = await makeAppRoot("myapp");
    await mkdir(projectConfigPath(root), { recursive: true });

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(
      /it is a directory, not a file/u,
    );
  });

  test("writes the project config 0600 inside a 0700 directory", async () => {
    const root = await makeAppRoot("myapp");

    await handleInitCommand({}, { cwd: root });

    expect((await stat(projectConfigPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(projectConfigPath(root)))).mode & 0o777).toBe(0o700);
  });

  // `mkdir`/`writeFile` modes apply only at creation, so a directory left loose by an earlier
  // version, a umask, or a `git checkout` has to be repaired by a later run.
  test("tightens loose modes on a --force run", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "stale" });
    await chmod(path.dirname(projectConfigPath(root)), 0o755);
    await chmod(projectConfigPath(root), 0o644);

    await handleInitCommand({ force: true }, { cwd: root });

    expect((await stat(projectConfigPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(projectConfigPath(root)))).mode & 0o777).toBe(0o700);
  });

  test("tightens loose modes even on an idempotent no-op run", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "myapp" });
    await chmod(path.dirname(projectConfigPath(root)), 0o755);
    await chmod(projectConfigPath(root), 0o644);

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { changed: false } });
    expect((await stat(projectConfigPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(projectConfigPath(root)))).mode & 0o777).toBe(0o700);
  });

  // Run from `$HOME`, or from the parent of a `CORDIERITE_STATE_DIR`, `<cwd>/.cordierite` is the
  // daemon's state directory — where `key.pem` and the audit log live. Writing a config there and
  // calling it "safe to commit" would be an invitation to commit a private key.
  test("refuses to write into the active state directory", async () => {
    const parent = await makeAppRoot("myapp");
    const stateDir = path.join(parent, ".cordierite");

    await expect(handleInitCommand({}, { cwd: parent, stateDir })).rejects.toThrow(
      /Refusing to write[\s\S]*state directory/u,
    );
    await expect(stat(projectConfigPath(parent))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to write into <home>/.cordierite even with an unrelated state dir", async () => {
    const home = await makeAppRoot("myapp");

    await expect(
      handleInitCommand(
        {},
        { cwd: home, homeDir: home, stateDir: path.join(await makeAppRoot(), "elsewhere") },
      ),
    ).rejects.toThrow(/Refusing to write[\s\S]*state directory/u);
  });

  test("still writes normally in an app root that merely sits under the home directory", async () => {
    const home = await makeAppRoot();
    const appRoot = path.join(home, "projects", "demo");
    await mkdir(appRoot, { recursive: true });
    await writeFile(
      path.join(appRoot, "app.json"),
      JSON.stringify({ expo: { scheme: "myapp" } }),
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: appRoot, homeDir: home });

    expect(result).toMatchObject({ ok: true, data: { scheme: "myapp" } });
  });

  test("no divergence note when --scheme names the recorded value explicitly", async () => {
    const root = await makeAppRoot("renamed");
    await writeProjectConfigRaw(root, { scheme: "myapp" });

    const result = await handleInitCommand({ scheme: "myapp" }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "myapp", source: "--scheme" } });
    expect(result.ok && result.data.note).toBeUndefined();
  });

  test("--force replaces the scheme and preserves every other key", async () => {
    const root = await makeAppRoot("myapp");
    await mkdir(path.dirname(projectConfigPath(root)), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ scheme: "stale", somethingElse: { kept: true } }),
      "utf8",
    );

    const result = await handleInitCommand({ force: true }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "myapp", created: false, changed: true } });
    expect(await readProjectConfig(root)).toEqual({
      scheme: "myapp",
      somethingElse: { kept: true },
    });
  });

  test("keeps an existing scheme when app.json has none", async () => {
    const root = await makeAppRoot();
    await handleInitCommand({ scheme: "myapp" }, { cwd: root });

    const second = await handleInitCommand({}, { cwd: root });

    expect(second).toMatchObject({
      ok: true,
      data: { scheme: "myapp", source: "already-recorded", changed: false },
    });
  });

  test("fails with a usage error when no scheme can be found or given", async () => {
    const root = await makeAppRoot();

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(
      /No deep-link scheme found/u,
    );
  });

  test("rejects a scheme that is really a URL prefix", async () => {
    const root = await makeAppRoot();

    await expect(handleInitCommand({ scheme: "myapp://" }, { cwd: root })).rejects.toThrow(
      /Invalid deep-link scheme/u,
    );
  });

  test("reports a malformed existing project config instead of silently overwriting it", async () => {
    const root = await makeAppRoot("myapp");
    await mkdir(path.dirname(projectConfigPath(root)), { recursive: true });
    await writeFile(projectConfigPath(root), "{ not json", "utf8");

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(/Could not parse/u);
  });

  test("never generates key material or daemon state", async () => {
    const root = await makeAppRoot("myapp");

    await handleInitCommand({}, { cwd: root });

    await expect(stat(path.join(root, ".cordierite", "key.pem"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(root, ".cordierite", "daemon.sock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("cordierite init (CLI)", () => {
  test("is idempotent across two real CLI runs", async () => {
    const root = await makeAppRoot("myapp");
    const stateDir = await makeStateDir();

    const first = runCliBinary(["init", "--json"], { cwd: root, stateDir });
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      ok: true,
      data: { scheme: "myapp", created: true, changed: true },
    });

    const second = runCliBinary(["init", "--json"], { cwd: root, stateDir });
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      ok: true,
      data: { scheme: "myapp", created: false, changed: false },
    });

    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("prints the MCP snippet and the auto-import reminder", async () => {
    const root = await makeAppRoot("myapp");

    const result = runCliBinary(["init"], { cwd: root, stateDir: await makeStateDir() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"cordierite"');
    expect(result.stdout).toContain('"--scheme"');
    expect(result.stdout).toContain("myapp");
    expect(result.stdout).toContain('import "@cordierite/react-native/auto"');
  });

  test("exits 64 with a usage error when there is nothing to discover", async () => {
    const root = await makeAppRoot();

    const result = runCliBinary(["init", "--json"], { cwd: root, stateDir: await makeStateDir() });

    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { type: "usage_error" },
    });
  });

  test("--force is required to change a recorded scheme", async () => {
    const root = await makeAppRoot("myapp");
    const stateDir = await makeStateDir();

    runCliBinary(["init"], { cwd: root, stateDir });

    const refused = runCliBinary(["init", "--scheme", "other", "--json"], { cwd: root, stateDir });
    expect(refused.exitCode).toBe(64);

    const forced = runCliBinary(["init", "--scheme", "other", "--force", "--json"], {
      cwd: root,
      stateDir,
    });
    expect(forced.exitCode).toBe(0);
    expect(await readProjectConfig(root)).toEqual({ scheme: "other" });
  });
});
