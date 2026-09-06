/**
 * E2E scenario: state-dir retention (ARCHITECTURE.md §3, issue #32).
 *
 * `daemon.log` rotation only happens on the spawn path, and the spawn path only really exists in a
 * subprocess — so this is the one place that can prove `cordierite daemon start` rotates an
 * over-cap log before the new daemon opens it, and that the daemon it started reports its audit
 * footprint back through `daemon status`.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { getStateDirPaths } from "../../daemon/state-dir.js";
import { cleanupAfterEach, makeTempStateDir, runCliJson, trackDaemonPid } from "./harness.js";

afterEach(cleanupAfterEach);

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

describe("e2e: state-dir retention", () => {
  test(
    "daemon start rotates an over-cap daemon.log to daemon.log.1 (0600) and reports the audit footprint",
    async () => {
      const { stateDir } = await makeTempStateDir({ daemonLogMaxBytes: 1024, auditRetentionDays: 7 });
      const paths = getStateDirPaths(stateDir);

      // A log left behind by a previous daemon, well over the cap.
      const stale = "stale daemon output\n".repeat(200);
      await writeFile(paths.logFilePath, stale, { mode: 0o600 });
      expect(stale.length).toBeGreaterThan(1024);

      // A day file the startup sweep must delete. Written before the daemon starts, so the sweep
      // actually sees it.
      const { mkdir } = await import("node:fs/promises");
      await mkdir(paths.auditDir, { recursive: true });
      await writeFile(path.join(paths.auditDir, "2020-01-01.jsonl"), "{}\n", { mode: 0o600 });

      const start = await runCliJson<{ daemon: { pid: number; started_at: string } }>(
        ["daemon", "start"],
        stateDir,
      );
      expect(start.ok).toBe(true);
      trackDaemonPid(start.data!.daemon.pid);

      // "Today" comes from the daemon's own clock (`started_at`), not this process's, so the
      // fixture is dated by the same clock that decides what to prune — no UTC-rollover window
      // between the two. Written after startup, which is safe: the sweep has already run and the
      // next one is 24 h away, and today's file is one pruning can never take regardless.
      const today = start.data!.daemon.started_at.slice(0, 10);
      await writeFile(path.join(paths.auditDir, `${today}.jsonl`), "{}\n", { mode: 0o600 });

      // Rotated aside before the freshly spawned daemon opened its own log.
      const backupPath = `${paths.logFilePath}.1`;
      expect(await readFile(backupPath, "utf8")).toBe(stale);
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.logFilePath)).size).toBeLessThan(stale.length);
      expect((await stat(paths.logFilePath)).mode & 0o777).toBe(0o600);
      expect(await exists(`${backupPath}.1`)).toBe(false);

      // The startup sweep is fire-and-forget, so wait for its effect rather than assuming it has
      // landed by the time the status call returns.
      const stalePath = path.join(paths.auditDir, "2020-01-01.jsonl");
      const deadline = Date.now() + 5000;
      while ((await exists(stalePath)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await exists(stalePath)).toBe(false);
      expect(await exists(path.join(paths.auditDir, `${today}.jsonl`))).toBe(true);

      const status = await runCliJson<{
        audit: { path: string; retention_days: number; files: number; bytes: number; failed_prunes: number };
      }>(["daemon", "status"], stateDir);

      expect(status.ok).toBe(true);
      expect(status.data!.audit).toMatchObject({
        path: paths.auditDir,
        retention_days: 7,
        failed_prunes: 0,
      });
      expect(status.data!.audit.files).toBe(1);
      expect(status.data!.audit.bytes).toBeGreaterThan(0);

      const stop = await runCliJson(["daemon", "stop"], stateDir);
      expect(stop.ok).toBe(true);
    },
    30_000,
  );

  test(
    "a daemon.log within the cap is left alone by an auto-spawn",
    async () => {
      const { stateDir } = await makeTempStateDir({ daemonLogMaxBytes: 10 * 1024 * 1024 });
      const paths = getStateDirPaths(stateDir);
      await writeFile(paths.logFilePath, "small\n", { mode: 0o600 });

      const status = await runCliJson<{ daemon: { pid: number } }>(["daemon", "status"], stateDir);
      expect(status.ok).toBe(true);
      trackDaemonPid(status.data!.daemon.pid);

      expect(await exists(`${paths.logFilePath}.1`)).toBe(false);
      expect((await readFile(paths.logFilePath, "utf8")).startsWith("small\n")).toBe(true);

      await runCliJson(["daemon", "stop"], stateDir);
    },
    30_000,
  );
});
