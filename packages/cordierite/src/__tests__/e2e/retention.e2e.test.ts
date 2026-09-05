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

      // An audit day file the daemon must keep (inside the window) and one it must delete.
      const today = new Date().toISOString().slice(0, 10);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(paths.auditDir, { recursive: true });
      await writeFile(path.join(paths.auditDir, `${today}.jsonl`), "{}\n", { mode: 0o600 });
      await writeFile(path.join(paths.auditDir, "2020-01-01.jsonl"), "{}\n", { mode: 0o600 });

      const start = await runCliJson<{ daemon: { pid: number } }>(["daemon", "start"], stateDir);
      expect(start.ok).toBe(true);
      trackDaemonPid(start.data!.daemon.pid);

      // Rotated aside before the freshly spawned daemon opened its own log.
      const backupPath = `${paths.logFilePath}.1`;
      expect(await readFile(backupPath, "utf8")).toBe(stale);
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.logFilePath)).size).toBeLessThan(stale.length);
      expect((await stat(paths.logFilePath)).mode & 0o777).toBe(0o600);
      expect(await exists(`${backupPath}.1`)).toBe(false);

      const status = await runCliJson<{
        audit: { path: string; retention_days: number; files: number; bytes: number; failed_prunes: number };
      }>(["daemon", "status"], stateDir);

      expect(status.ok).toBe(true);
      expect(status.data!.audit).toMatchObject({
        path: paths.auditDir,
        retention_days: 7,
        failed_prunes: 0,
      });
      // The startup sweep deleted the 2020 file and kept today's.
      expect(status.data!.audit.files).toBe(1);
      expect(status.data!.audit.bytes).toBeGreaterThan(0);
      expect(await exists(path.join(paths.auditDir, "2020-01-01.jsonl"))).toBe(false);
      expect(await exists(path.join(paths.auditDir, `${today}.jsonl`))).toBe(true);

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
