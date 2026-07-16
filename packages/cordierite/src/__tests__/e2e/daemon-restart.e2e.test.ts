/**
 * Task 16 scenario: daemon restart. Killing the daemon (SIGKILL) mid-session must not require
 * operator intervention: the next CLI command auto-spawns a fresh daemon (recovering the stale
 * pidfile/socket left behind), the old session is gone (documented behavior — ARCHITECTURE.md §3:
 * "no per-session files, all state in-daemon-memory" — sessions do not survive daemon death), and a
 * new link/claim works against the fresh daemon.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { FakeAppClient } from "./app-client.js";
import {
  cleanupAfterEach,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  runCliJson,
  trackDaemonPid,
  untrackDaemonPid,
} from "./harness.js";

afterEach(cleanupAfterEach);

describe("e2e: daemon restart", () => {
  test(
    "SIGKILL mid-session -> next command auto-spawns a fresh daemon, old session gone, new link/claim works",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      const firstPid = await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      await app.claim(link, { model: "Pixel 8" });

      const socketClosed = app.waitForClose();

      // Kill the daemon outright — this test owns the kill, so it un-tracks the pid rather than
      // leaving `cleanupAfterEach` to (harmlessly, but confusingly) signal an already-dead process.
      process.kill(firstPid, "SIGKILL");
      untrackDaemonPid(firstPid);

      // The OS tears down the daemon's sockets when the process dies; the fake app observes that as
      // an ungraceful close.
      await socketClosed;

      // The next command has nothing listening at the stale socket path: it must auto-spawn a fresh
      // daemon rather than fail (ARCHITECTURE.md §4: "a stale socket file with a dead pid is
      // unlinked before spawning").
      const lsResult = await runCliJson<unknown[]>(["ls"], stateDir);
      expect(lsResult.ok).toBe(true);
      // The old session does not survive daemon death (documented behavior, not a bug).
      expect(lsResult.data).toEqual([]);

      const statusResult = await runCliJson<{ daemon: { pid: number } }>(["daemon", "status"], stateDir);
      expect(statusResult.ok).toBe(true);
      const secondPid = statusResult.data!.daemon.pid;
      expect(secondPid).not.toBe(firstPid);

      // Cleanup tracks the *new* daemon, not the one this test already killed.
      trackDaemonPid(secondPid);

      // A brand-new link/claim against the fresh daemon works end-to-end.
      const freshLink = await mintLink(stateDir);
      const freshApp = new FakeAppClient(port, pinnedKeys);
      const freshAck = await freshApp.claim(freshLink, { model: "Pixel 8" });
      expect(freshAck.status).toBe("ok");
      expect(freshAck.alias).toBe("pixel-8");

      freshApp.close();
    },
    20_000,
  );
});
