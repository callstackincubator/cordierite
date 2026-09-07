/**
 * Issue #29's headline acceptance criterion, end to end against a real daemon: an app directory
 * whose only Cordierite-relevant file is `app.json` with `expo.scheme` can mint a link with an
 * otherwise-empty state dir — no `config.json`, no `cordierite init`, no hand-editing.
 *
 * The state dir here does hold `wssPort`/`advertisedIp`/`key.pem` because the test daemon needs a
 * free port and a key, but it never holds a `scheme`: that is the value under test.
 */

import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { handleLinkCommand } from "../commands/link.js";
import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { writeTestHostKey } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (directories.length > 0) {
    await rm(directories.pop()!, { force: true, recursive: true });
  }
});

const pickFreePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
};

/** A daemon whose `config.json` deliberately carries no `scheme`. */
const startSchemelessDaemon = async (): Promise<string> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-discovery-state-"));
  directories.push(stateDir);
  await writeTestHostKey(path.join(stateDir, "key.pem"));

  await writeFile(
    path.join(stateDir, "config.json"),
    JSON.stringify({ wssPort: await pickFreePort(), advertisedIp: "127.0.0.1" }),
  );

  runningDaemons.push(await startDaemon({ stateDir }));

  return stateDir;
};

const makeAppRoot = async (expoScheme?: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "cordierite-discovery-app-"));
  directories.push(root);

  if (expoScheme !== undefined) {
    await writeFile(
      path.join(root, "app.json"),
      JSON.stringify({ expo: { name: "Demo", scheme: expoScheme } }),
    );
  }

  return root;
};

const failIfCalled = (): never => {
  throw new Error("auto-spawn should never be needed: the test daemon is already running.");
};

const mint = async (stateDir: string, cwd: string, scheme?: string) => {
  return handleLinkCommand(
    { scheme },
    // `schemeEnv` (not `env`, which is the adb/simctl environment) is pinned empty so an exported
    // CORDIERITE_SCHEME on the developer's machine cannot decide these assertions.
    { stateDir, cwd, spawn: failIfCalled, schemeEnv: {} },
  );
};

describe("cordierite link scheme discovery", () => {
  test("mints from an app.json alone, with no scheme configured anywhere", async () => {
    const stateDir = await startSchemelessDaemon();
    const appRoot = await makeAppRoot("myapp");

    const result = await mint(stateDir, appRoot);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.deepLink).toMatch(/^myapp:\/\/\/\?cordierite=/u);
  });

  test("a project .cordierite/config.json found by walking up wins over app.json", async () => {
    const stateDir = await startSchemelessDaemon();
    const appRoot = await makeAppRoot("from-app-json");
    await mkdir(path.join(appRoot, ".cordierite"), { recursive: true });
    await writeFile(
      path.join(appRoot, ".cordierite", "config.json"),
      JSON.stringify({ scheme: "from-project-config" }),
    );

    const nested = path.join(appRoot, "src", "screens");
    await mkdir(nested, { recursive: true });

    // Run from a subdirectory: the walk-up is what makes `cordierite link` work anywhere in a repo.
    const result = await mint(stateDir, nested);

    expect(result.ok && result.data.deepLink).toMatch(/^from-project-config:\/\/\/\?cordierite=/u);
  });

  test("--scheme still wins over everything discovered", async () => {
    const stateDir = await startSchemelessDaemon();
    const appRoot = await makeAppRoot("from-app-json");

    const result = await mint(stateDir, appRoot, "from-flag");

    expect(result.ok && result.data.deepLink).toMatch(/^from-flag:\/\/\/\?cordierite=/u);
  });

  test("fails with a usage error naming every location when nothing declares a scheme", async () => {
    const stateDir = await startSchemelessDaemon();
    const appRoot = await makeAppRoot();

    await expect(mint(stateDir, appRoot)).rejects.toThrow(
      /A deep-link scheme is required[\s\S]*CORDIERITE_SCHEME[\s\S]*app\.json/u,
    );
  });
});
