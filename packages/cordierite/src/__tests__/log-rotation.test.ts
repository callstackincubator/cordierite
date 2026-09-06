/**
 * `daemon.log` rotation (ARCHITECTURE.md §3/§4). Real temp state dirs throughout — the whole
 * point of the module is filesystem behavior (sizes, renames, modes), so there is nothing here
 * worth faking.
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_DAEMON_LOG_MAX_BYTES } from "../daemon/config.js";
import {
  daemonLogBackupPath,
  ensureDaemonLogMode,
  resolveDaemonLogMaxBytes,
  rotateDaemonLogIfNeeded,
} from "../daemon/log-rotation.js";
import { getStateDirPaths } from "../daemon/state-dir.js";

/**
 * `chmod` is mocked only for paths explicitly armed by a test — the "the rename succeeded but the
 * mode could not follow" case, which a real filesystem will not produce on demand for a file this
 * process just created and owns (and which root could not be denied anyway). Every other call,
 * here and in the code under test, reaches the real implementation.
 */
const mocked = vi.hoisted(() => ({ chmodFailsFor: new Set<string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    chmod: async (target: Parameters<typeof actual.chmod>[0], mode: Parameters<typeof actual.chmod>[1]) => {
      if (typeof target === "string" && mocked.chmodFailsFor.has(target)) {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }

      return actual.chmod(target, mode);
    },
  };
});

const stateDirs: string[] = [];

afterEach(async () => {
  mocked.chmodFailsFor.clear();

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

  test("refuses to rotate when the control socket still accepts a connection", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath, socketPath } = getStateDirPaths(stateDir);
    const warnings: string[] = [];
    const contents = "held by a daemon whose pidfile we cannot see\n".repeat(100);
    await writeFile(logFilePath, contents, { mode: 0o600 });

    // No pidfile at all — the case the pidfile guard alone cannot catch: a daemon that has its
    // log fd and its socket up but has not written (or has already removed) daemon.pid.
    const server = createNetServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      await expect(
        rotateDaemonLogIfNeeded({
          logFilePath,
          maxBytes: 10,
          socketPath,
          warn: (message) => warnings.push(message),
        }),
      ).resolves.toEqual({ rotated: false, skipped: "daemon_running" });

      expect(await readFile(logFilePath, "utf8")).toBe(contents);
      expect(await exists(daemonLogBackupPath(logFilePath))).toBe(false);
      expect(warnings.length).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Once the listener is gone the same call rotates: nothing holds the log any more.
    await expect(rotateDaemonLogIfNeeded({ logFilePath, maxBytes: 10, socketPath })).resolves.toMatchObject({
      rotated: true,
    });
  });

  test("a chmod failure after a successful rename still reports the rotation", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath } = getStateDirPaths(stateDir);
    const warnings: string[] = [];
    await writeFile(logFilePath, "d".repeat(64), { mode: 0o600 });

    // EPERM on the backup only: the rename lands, the mode fix cannot follow — what a
    // drvfs/NFS/SMB-backed state dir does.
    const backupPath = daemonLogBackupPath(logFilePath);
    mocked.chmodFailsFor.add(backupPath);

    const result = await rotateDaemonLogIfNeeded({
      logFilePath,
      maxBytes: 10,
      warn: (message) => warnings.push(message),
    });

    // The rename happened, so the rotation is reported as one — a chmod that could not follow must
    // not turn a completed rotation into "rotated: false" under a warning about the wrong step.
    expect(result).toEqual({ rotated: true, rotatedBytes: 64 });
    expect(await exists(logFilePath)).toBe(false);
    expect(await readFile(backupPath, "utf8")).toBe("d".repeat(64));
    expect(warnings.length).toBe(1);
    // Names the step that actually failed, not the rotation.
    expect(warnings[0]).toContain("could not set 0600");
    expect(warnings[0]).toContain("rotated");
    expect(warnings[0]).not.toContain("failed to rotate");
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

describe("daemon.log mode enforcement", () => {
  test("sets 0600 on a log that was created too permissively", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath } = getStateDirPaths(stateDir);
    const warnings: string[] = [];
    await writeFile(logFilePath, "x", { mode: 0o644 });
    await chmod(logFilePath, 0o644); // defeat any umask narrowing above

    await expect(ensureDaemonLogMode(logFilePath, (message) => warnings.push(message))).resolves.toBe(true);
    expect((await stat(logFilePath)).mode & 0o777).toBe(0o600);
    expect(warnings).toEqual([]);
  });

  test("warns and carries on when the mode cannot be set", async () => {
    const stateDir = await makeStateDir();
    const { logFilePath } = getStateDirPaths(stateDir);
    const warnings: string[] = [];

    // A missing file stands in for the EPERM/ENOTSUP a drvfs/NFS/SMB-backed state dir or a
    // root-owned log produces: the point is that *any* chmod error is survivable here, because
    // this sits on the auto-spawn path that every CLI and MCP command goes through.
    await expect(ensureDaemonLogMode(logFilePath, (message) => warnings.push(message))).resolves.toBe(false);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(logFilePath);
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
