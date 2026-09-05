/**
 * `daemon.log` rotation (ARCHITECTURE.md §3/§4). Real temp state dirs throughout — the whole
 * point of the module is filesystem behavior (sizes, renames, modes), so there is nothing here
 * worth faking.
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_DAEMON_LOG_MAX_BYTES } from "../daemon/config.js";
import {
  daemonLogBackupPath,
  resolveDaemonLogMaxBytes,
  rotateDaemonLogIfNeeded,
} from "../daemon/log-rotation.js";
import { getStateDirPaths } from "../daemon/state-dir.js";

const stateDirs: string[] = [];

afterEach(async () => {
  while (stateDirs.length > 0) {
    await rm(stateDirs.pop()!, { force: true, recursive: true });
  }
});

const makeStateDir = async (): Promise<string> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-log-rotation-"));
  stateDirs.push(stateDir);
  return stateDir;
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

describe("daemon.log rotation", () => {
  test("rotates an over-cap log to daemon.log.1 and leaves it at 0600", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath } = getStateDirPaths(stateDir);
    await writeFile(logFilePath, "x".repeat(2048), { mode: 0o600 });

    await expect(rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 1024 })).resolves.toEqual({
      rotated: true,
      rotatedBytes: 2048,
    });

    expect(await exists(logFilePath)).toBe(false);
    const backupPath = daemonLogBackupPath(logFilePath);
    expect((await readFile(backupPath, "utf8")).length).toBe(2048);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  test("leaves a log at or below the cap alone", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath } = getStateDirPaths(stateDir);
    await writeFile(logFilePath, "x".repeat(1024), { mode: 0o600 });

    await expect(rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 1024 })).resolves.toEqual({ rotated: false });

    expect((await readFile(logFilePath, "utf8")).length).toBe(1024);
    expect(await exists(daemonLogBackupPath(logFilePath))).toBe(false);
  });

  test("a missing log is a silent no-op", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath } = getStateDirPaths(stateDir);
    const warnings: string[] = [];

    await expect(
      rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 1024, warn: (message) => warnings.push(message) }),
    ).resolves.toEqual({ rotated: false });

    expect(warnings).toEqual([]);
    expect(await exists(logFilePath)).toBe(false);
  });

  test("keeps a single backup: the previous daemon.log.1 is replaced, and its mode is repaired", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath } = getStateDirPaths(stateDir);
    const backupPath = daemonLogBackupPath(logFilePath);

    await writeFile(backupPath, "older", { mode: 0o600 });
    await chmod(backupPath, 0o644); // e.g. an operator's `cp`, or a backup predating this code
    await writeFile(logFilePath, "y".repeat(2048), { mode: 0o600 });

    await expect(rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 10 })).resolves.toMatchObject({ rotated: true });

    expect((await readFile(backupPath, "utf8")).startsWith("y")).toBe(true);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    // Still exactly one backup — no daemon.log.2 chain.
    expect(await exists(`${backupPath}.1`)).toBe(false);
  });

  test("refuses to rotate an over-cap log a live daemon still holds", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath, pidFilePath } = getStateDirPaths(stateDir);
    const warnings: string[] = [];
    const contents = "held by a running daemon\n".repeat(100);
    await writeFile(logFilePath, contents, { mode: 0o600 });

    // This test process is unambiguously alive, so it stands in for a daemon that is booting,
    // wedged, or shutting down: socket unreachable, log fd very much still open.
    await writeFile(pidFilePath, String(process.pid), { mode: 0o600 });

    await expect(
      rotateDaemonLogIfNeeded({
        logFilePath,
        maxBytes: 10,
        pidFilePath,
        warn: (message) => warnings.push(message),
      }),
    ).resolves.toEqual({ rotated: false, skipped: "daemon_running" });

    // Nothing moved: the daemon's fd still points at the file the operator will go looking in.
    expect(await readFile(logFilePath, "utf8")).toBe(contents);
    expect(await exists(daemonLogBackupPath(logFilePath))).toBe(false);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(logFilePath);
  });

  test("rotates when the pidfile names a dead process, or names nothing at all", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath, pidFilePath } = getStateDirPaths(stateDir);

    // No pidfile: nothing can be holding the log.
    await writeFile(logFilePath, "a".repeat(64), { mode: 0o600 });
    await expect(rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 10, pidFilePath })).resolves.toMatchObject({
      rotated: true,
    });

    // A pidfile left behind by a daemon that died without releasing it — the stale case the
    // auto-spawn path already recovers from elsewhere.
    await writeFile(pidFilePath, "999999999", { mode: 0o600 });
    await writeFile(logFilePath, "b".repeat(64), { mode: 0o600 });
    await expect(rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 10, pidFilePath })).resolves.toMatchObject({
      rotated: true,
    });
    expect((await readFile(daemonLogBackupPath(logFilePath), "utf8")).startsWith("b")).toBe(true);

    // An unparseable pidfile reads the same way every other consumer reads it: nothing running.
    await writeFile(pidFilePath, "not-a-pid", { mode: 0o600 });
    await writeFile(logFilePath, "c".repeat(64), { mode: 0o600 });
    await expect(rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 10, pidFilePath })).resolves.toMatchObject({
      rotated: true,
    });
  });

  test("a live pidfile does not stop a within-cap log from being left alone", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath, pidFilePath } = getStateDirPaths(stateDir);
    await writeFile(logFilePath, "small\n", { mode: 0o600 });
    await writeFile(pidFilePath, String(process.pid), { mode: 0o600 });

    // No `skipped` marker: the log was never a rotation candidate in the first place.
    await expect(rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 1024, pidFilePath })).resolves.toEqual({
      rotated: false,
    });
  });

  test("a rotation failure is warned and swallowed, never thrown", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath } = getStateDirPaths(stateDir);
    const warnings: string[] = [];

    // A directory where the log should be: `stat` succeeds, `isFile()` is false, so there is
    // nothing to rotate and nothing to warn about either.
    await rm(logFilePath, { force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(logFilePath, { recursive: true });

    await expect(
      rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 0, warn: (message) => warnings.push(message) }),
    ).resolves.toEqual({ rotated: false });
    expect(warnings).toEqual([]);

    // A rename that cannot succeed (the destination is a non-empty directory) is warned, not thrown.
    await rm(logFilePath, { force: true, recursive: true });
    await writeFile(logFilePath, "z".repeat(64), { mode: 0o600 });
    await mkdir(daemonLogBackupPath(logFilePath), { recursive: true });
    await writeFile(path.join(daemonLogBackupPath(logFilePath), "blocker"), "x");

    await expect(
      rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 1, warn: (message) => warnings.push(message) }),
    ).resolves.toEqual({ rotated: false });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(logFilePath);
    // The log itself survives a failed rotation — nothing is lost.
    expect((await readFile(logFilePath, "utf8")).length).toBe(64);
  });
});

describe("daemon.log rotation: cap resolution", () => {
  test("defaults to 10 MiB with no config.json", async () => {
    const stateDir = await makeStateDir();

    await expect(resolveDaemonLogMaxBytes(stateDir)).resolves.toBe(DEFAULT_DAEMON_LOG_MAX_BYTES);
    expect(DEFAULT_DAEMON_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  test("honors config.daemonLogMaxBytes", async () => {
    const stateDir = await makeStateDir();
    const { configPath } = getStateDirPaths(stateDir);
    await writeFile(configPath, JSON.stringify({ daemonLogMaxBytes: 4096 }));

    await expect(resolveDaemonLogMaxBytes(stateDir)).resolves.toBe(4096);
  });

  test("falls back to the default when config.json is unreadable, rather than failing the spawn", async () => {
    const stateDir = await makeStateDir();
    const { configPath } = getStateDirPaths(stateDir);
    await writeFile(configPath, "{ not json");

    await expect(resolveDaemonLogMaxBytes(stateDir)).resolves.toBe(DEFAULT_DAEMON_LOG_MAX_BYTES);
  });
});
