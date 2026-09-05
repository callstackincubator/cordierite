/**
 * E2E scenario: daemon/CLI version drift (issue #30). Upgrading the CLI leaves the previously
 * spawned daemon running on the old build, and every later command silently keeps talking to it.
 * Here a real daemon subprocess is started with `CORDIERITE_DAEMON_VERSION_OVERRIDE` so it reports
 * a version this CLI never shipped, and real CLI subprocesses then have to notice.
 *
 * Kept separate from `daemon-restart.e2e.test.ts`, which covers crash recovery (SIGKILL), not
 * drift — the two share nothing but the word "restart".
 */

import { readFileSync } from "node:fs";
import { connect as connectUds } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { decodeBootstrap } from "@cordierite/shared";

import { getStateDirPaths } from "../../daemon/state-dir.js";
import { FakeAppClient } from "./app-client.js";
import {
  cleanupAfterEach,
  fetchPinnedKeys,
  makeTempStateDir,
  packageRoot,
  runCliJson,
  spawnCli,
  trackCleanup,
  trackDaemonPid,
  untrackDaemonPid,
  waitUntil,
  type DecodedLink,
} from "./harness.js";

afterEach(cleanupAfterEach);

const STALE_VERSION = "0.0.1-stale";

const CLI_VERSION: string = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
).version;

type DaemonStatus = {
  daemon: { version: string; pid: number; session_count: number };
  warning?: string;
};

/**
 * Reads status through a real `cordierite daemon status --json`. That command is deliberately
 * excluded from the version check (it warns instead of restarting), which is exactly what makes it
 * usable here: every assertion about "which daemon is running now" must not itself replace it.
 */
const readStatus = async (stateDir: string): Promise<DaemonStatus> => {
  const result = await runCliJson<DaemonStatus>(["daemon", "status"], stateDir);

  if (!result.ok || !result.data) {
    throw new Error(`"daemon status" failed: ${JSON.stringify(result)}`);
  }

  return result.data;
};

/**
 * One raw JSON-RPC request over the control socket. Used only to mint a link for the live-session
 * scenario: `cordierite link` is itself one of the commands that runs the version check, so using
 * it as *setup* would restart the very daemon the test needs to keep stale. Every scenario action
 * still goes through a real CLI subprocess or the fake app client.
 */
const rawRpc = <TResult>(stateDir: string, method: string, params: unknown = {}): Promise<TResult> => {
  const { socketPath } = getStateDirPaths(stateDir);

  return new Promise<TResult>((resolve, reject) => {
    const socket = connectUds(socketPath);
    let buffer = "";

    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      socket.destroy();

      const message = JSON.parse(buffer.slice(0, newlineIndex)) as {
        result?: TResult;
        error?: { message: string };
      };

      if (message.error) {
        reject(new Error(`${method} failed: ${message.error.message}`));
        return;
      }

      resolve(message.result as TResult);
    });
  });
};

/** Starts a real `cordierite daemon run` subprocess that reports `STALE_VERSION`. */
const startStaleDaemon = async (stateDir: string): Promise<number> => {
  const proc = spawnCli(["daemon", "run"], stateDir, {
    CORDIERITE_DAEMON_VERSION_OVERRIDE: STALE_VERSION,
  });

  // `daemon run` streams its bootstrap render; leaving the pipes unread would eventually stall it.
  proc.stdout.resume();
  proc.stderr.resume();
  trackCleanup(() => {
    proc.kill("SIGKILL");
  });

  const { socketPath } = getStateDirPaths(stateDir);

  await waitUntil(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = connectUds(socketPath);
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(false);
        });
      }),
    { timeoutMs: 10_000, description: "the stale daemon's control socket" },
  );

  const status = await readStatus(stateDir);
  expect(status.daemon.version).toBe(STALE_VERSION);

  trackDaemonPid(status.daemon.pid);
  return status.daemon.pid;
};

/** Mints a link over the raw control socket (see {@link rawRpc}) and decodes it for the fake app. */
const mintLinkWithoutCli = async (stateDir: string): Promise<DecodedLink> => {
  const result = await rawRpc<{ deepLinkPayload: string }>(stateDir, "link.create", {});
  const decoded = decodeBootstrap(result.deepLinkPayload);

  if (!decoded) {
    throw new Error("Failed to decode the bootstrap payload minted for the version-drift test.");
  }

  return { sessionId: decoded.sessionId, token: decoded.token, port: decoded.port };
};

describe("e2e: daemon/CLI version drift", () => {
  test(
    "an idle stale daemon is replaced transparently by the next command",
    async () => {
      const { stateDir } = await makeTempStateDir();
      const stalePid = await startStaleDaemon(stateDir);

      const lsResult = await runCliJson<unknown[]>(["ls"], stateDir);
      expect(lsResult.ok).toBe(true);
      expect(lsResult.data).toEqual([]);

      // The command was served by a daemon of this build, spawned in place of the stale one.
      const status = await readStatus(stateDir);
      expect(status.daemon.version).toBe(CLI_VERSION);
      expect(status.daemon.pid).not.toBe(stalePid);
      expect(status.warning).toBeUndefined();

      untrackDaemonPid(stalePid);
      trackDaemonPid(status.daemon.pid);

      // The stale daemon really went away rather than being orphaned next to its replacement.
      await waitUntil(() => !isAlive(stalePid), {
        timeoutMs: 5000,
        description: "the stale daemon process to exit",
      });
    },
    30_000,
  );

  test(
    "a stale daemon with a live session is reported, not restarted",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      const stalePid = await startStaleDaemon(stateDir);

      const pinnedKeys = await fetchPinnedKeys(stateDir);
      const link = await mintLinkWithoutCli(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      await app.claim(link, { model: "Pixel 8" });

      try {
        const lsResult = await runCliJson(["ls"], stateDir);

        expect(lsResult.ok).toBe(false);
        expect(lsResult.exitCode).toBe(70);
        expect(lsResult.error?.type).toBe("connection_error");
        // Both versions and the remedies are named, which is the whole point: a "method not found"
        // for a command the user just installed tells them nothing.
        expect(lsResult.error?.message).toContain(STALE_VERSION);
        expect(lsResult.error?.message).toContain(CLI_VERSION);
        expect(lsResult.error?.message).toContain("cordierite daemon stop");
        expect(lsResult.error?.message).toContain("--daemon-restart");
        expect(lsResult.error?.details).toMatchObject({
          daemon_version: STALE_VERSION,
          client_version: CLI_VERSION,
          session_count: 1,
        });

        // The operator's daemon — and their session — are exactly where they were.
        const status = await readStatus(stateDir);
        expect(status.daemon.pid).toBe(stalePid);
        expect(status.daemon.version).toBe(STALE_VERSION);
        expect(status.daemon.session_count).toBe(1);
      } finally {
        app.close();
      }
    },
    30_000,
  );

  test(
    "--daemon-restart replaces a stale daemon even with a live session",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      const stalePid = await startStaleDaemon(stateDir);

      const pinnedKeys = await fetchPinnedKeys(stateDir);
      const link = await mintLinkWithoutCli(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      await app.claim(link, { model: "Pixel 8" });
      const socketClosed = app.waitForClose();

      const lsResult = await runCliJson<unknown[]>(["ls", "--daemon-restart"], stateDir);
      expect(lsResult.ok).toBe(true);
      // The session went with the old daemon — the documented cost the default refuses to pay.
      expect(lsResult.data).toEqual([]);

      await socketClosed;

      const status = await readStatus(stateDir);
      expect(status.daemon.version).toBe(CLI_VERSION);
      expect(status.daemon.pid).not.toBe(stalePid);
      expect(status.daemon.session_count).toBe(0);

      untrackDaemonPid(stalePid);
      trackDaemonPid(status.daemon.pid);

      app.close();
    },
    30_000,
  );

  test(
    "daemon status warns about drift and leaves the daemon it was asked about alone",
    async () => {
      const { stateDir } = await makeTempStateDir();
      const stalePid = await startStaleDaemon(stateDir);

      const status = await readStatus(stateDir);

      expect(status.warning).toContain(STALE_VERSION);
      expect(status.warning).toContain(CLI_VERSION);
      expect(status.warning).toContain("cordierite daemon stop");
      // Diagnosing a daemon must never replace it.
      expect(status.daemon.pid).toBe(stalePid);
      expect(status.daemon.version).toBe(STALE_VERSION);
    },
    30_000,
  );
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("e2e: forcing a version-drift restart", () => {
  test(
    "CORDIERITE_DAEMON_RESTART=1 forces the restart with no flag on the command line",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      const stalePid = await startStaleDaemon(stateDir);

      const pinnedKeys = await fetchPinnedKeys(stateDir);
      const link = await mintLinkWithoutCli(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      await app.claim(link, { model: "Pixel 8" });

      // The env form exists for exactly this: an MCP launch config passes no CLI flags.
      const lsResult = await runCliJson<unknown[]>(["ls"], stateDir, {
        CORDIERITE_DAEMON_RESTART: "1",
      });

      expect(lsResult.ok).toBe(true);
      expect(lsResult.data).toEqual([]);

      const status = await readStatus(stateDir);
      expect(status.daemon.version).toBe(CLI_VERSION);
      expect(status.daemon.pid).not.toBe(stalePid);

      untrackDaemonPid(stalePid);
      trackDaemonPid(status.daemon.pid);

      app.close();
    },
    30_000,
  );

  test(
    "--no-daemon-restart overrules restartDaemonOnVersionMismatch for one command",
    async () => {
      const { stateDir, port } = await makeTempStateDir({ restartDaemonOnVersionMismatch: true });
      const stalePid = await startStaleDaemon(stateDir);

      const pinnedKeys = await fetchPinnedKeys(stateDir);
      const link = await mintLinkWithoutCli(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      await app.claim(link, { model: "Pixel 8" });

      try {
        // Config says "always restart"; the flag says "not this time". A flag that parsed cleanly
        // and then did nothing would be the worst outcome for a knob that decides whether the
        // operator's connected device survives the next command.
        const lsResult = await runCliJson(["ls", "--no-daemon-restart"], stateDir);

        expect(lsResult.ok).toBe(false);
        expect(lsResult.error?.type).toBe("connection_error");
        expect(lsResult.error?.message).toContain(STALE_VERSION);

        const status = await readStatus(stateDir);
        expect(status.daemon.pid).toBe(stalePid);
        expect(status.daemon.session_count).toBe(1);
      } finally {
        app.close();
      }
    },
    30_000,
  );

  test(
    "an unclaimed link blocks a restart, and the message says so",
    async () => {
      const { stateDir } = await makeTempStateDir();
      const stalePid = await startStaleDaemon(stateDir);

      // A minted-but-unclaimed link is a QR code someone may be walking over to scan. It is not a
      // session, so nothing in `sessions` protects it — the daemon reports it separately.
      await mintLinkWithoutCli(stateDir);

      const lsResult = await runCliJson(["ls"], stateDir);

      expect(lsResult.ok).toBe(false);
      expect(lsResult.error?.type).toBe("connection_error");
      expect(lsResult.error?.message).toContain("unclaimed link(s)");
      expect(lsResult.error?.details).toMatchObject({ session_count: 0, pending_link_count: 1 });

      const status = await readStatus(stateDir);
      expect(status.daemon.pid).toBe(stalePid);
    },
    30_000,
  );
});
