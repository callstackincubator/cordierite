import { spawnSync } from "node:child_process";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { handleDaemonStatusCommand } from "../commands/daemon.js";
import { AUDIT_PRUNE_INTERVAL_MS, startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { DaemonAlreadyRunningError } from "../daemon/pidfile.js";
import { startRpcServer } from "../daemon/rpc-server.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import { systemTimers, type IntervalHandle, type TimerFns } from "../daemon/timers.js";
import { writeTestHostKey } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];

const startTrackedDaemon = async (stateDir: string): Promise<RunningDaemon> => {
  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);
  return daemon;
};

afterEach(async () => {
  while (runningDaemons.length > 0) {
    const daemon = runningDaemons.pop();
    await daemon?.shutdown();
  }
});

const makeTempStateDir = async (): Promise<string> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-daemon-test-"));
  await writeTestHostKey(path.join(stateDir, "key.pem"));
  return stateDir;
};

/** Reads newline-delimited JSON-RPC responses off a raw socket, resolving each awaited line. */
const createLineReader = (socket: Socket) => {
  let buffer = "";
  const pendingLines: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      const waiter = waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        pendingLines.push(line);
      }
    }
  });

  return {
    nextLine: (): Promise<string> => {
      const buffered = pendingLines.shift();
      if (buffered !== undefined) {
        return Promise.resolve(buffered);
      }

      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
};

const connectRaw = (socketPath: string): Promise<Socket> => {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
};

describe("daemon lifecycle", () => {
  test("daemon.status round-trips over the real UDS", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startTrackedDaemon(stateDir);

    const paths = getStateDirPaths(stateDir);
    expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.socketPath)).mode & 0o777).toBe(0o600);
    // `audit/` must be tightened explicitly: `mkdir` honors the process umask, which on a common
    // 0o022 umask would otherwise leave it drwxr-xr-x (ARCHITECTURE.md §3: mode 0700).
    expect((await stat(paths.auditDir)).mode & 0o777).toBe(0o700);

    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.status", params: {} })}\n`);
    const line = await reader.nextLine();
    const response = JSON.parse(line);

    expect(response.id).toBe(1);
    expect(response.result).toMatchObject({
      pid: process.pid,
      wssPort: 8443,
      sessions: [],
    });
    expect(response.result.pinnedKeys).toHaveLength(1);
    expect(response.result.pinnedKeys[0]).toMatch(/^sha256\//u);
    expect(response.result.version).toBeTypeOf("string");
    expect(response.result.startedAt).toBe(daemon.startedAt.toISOString());

    socket.destroy();
    await rm(stateDir, { force: true, recursive: true });
  });

  test("malformed JSON line gets a JSON-RPC parse error and the connection stays usable", async () => {
    const stateDir = await makeTempStateDir();
    await startTrackedDaemon(stateDir);
    const paths = getStateDirPaths(stateDir);

    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);

    socket.write("{ not json \n");
    const badLineResponse = JSON.parse(await reader.nextLine());
    expect(badLineResponse.error.code).toBe(-32700);

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "daemon.status" })}\n`);
    const goodLineResponse = JSON.parse(await reader.nextLine());
    expect(goodLineResponse.id).toBe(7);
    expect(goodLineResponse.result.pid).toBe(process.pid);

    socket.destroy();
    await rm(stateDir, { force: true, recursive: true });
  });

  test("unknown method returns JSON-RPC -32601", async () => {
    const stateDir = await makeTempStateDir();
    await startTrackedDaemon(stateDir);
    const paths = getStateDirPaths(stateDir);

    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nonexistent.method" })}\n`);
    const response = JSON.parse(await reader.nextLine());

    expect(response.error.code).toBe(-32601);

    socket.destroy();
    await rm(stateDir, { force: true, recursive: true });
  });

  test("a line beyond the configured cap gets an error and the connection is dropped", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { ensureStateDir } = await import("../daemon/state-dir.js");
    await ensureStateDir(stateDir);

    const server = await startRpcServer({
      socketPath: paths.socketPath,
      dispatch: { "daemon.status": () => ({ ok: true }) },
      maxLineBytes: 64,
    });

    try {
      const socket = await connectRaw(paths.socketPath);
      const reader = createLineReader(socket);
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));

      const oversizedLine = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "daemon.status",
        params: { padding: "x".repeat(200) },
      });
      socket.write(`${oversizedLine}\n`);

      const response = JSON.parse(await reader.nextLine());
      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toMatch(/exceeds the 64-byte limit/u);

      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      await server.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });

  test("daemon.shutdown acks then closes the socket and removes sock + pid files", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startTrackedDaemon(stateDir);
    runningDaemons.pop(); // shutting down manually below; don't double-shutdown in afterEach.
    const paths = getStateDirPaths(stateDir);

    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "daemon.shutdown" })}\n`);
    const response = JSON.parse(await reader.nextLine());
    expect(response.result).toEqual({ ok: true });

    await daemon.exited;

    await expect(stat(paths.socketPath)).rejects.toThrow();
    await expect(stat(paths.pidFilePath)).rejects.toThrow();

    socket.destroy();
    await rm(stateDir, { force: true, recursive: true });
  });

  test("second daemon against the same state dir throws DaemonAlreadyRunningError", async () => {
    const stateDir = await makeTempStateDir();
    const first = await startTrackedDaemon(stateDir);

    await expect(startDaemon({ stateDir })).rejects.toThrow(DaemonAlreadyRunningError);

    await first.shutdown();
    await rm(stateDir, { force: true, recursive: true });
  });

  test("takes over a stale pidfile and stale socket left by a dead process", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);

    // A genuinely-dead pid: spawn a no-op child and wait for it to exit.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(dead.status).toBe(0);
    const deadPid = dead.pid;
    expect(deadPid).toBeGreaterThan(0);

    await writeFile(paths.pidFilePath, String(deadPid), { mode: 0o600 });
    // A stale socket file (not actually listening) left behind by the "crashed" daemon.
    await writeFile(paths.socketPath, "", { mode: 0o600 });

    const daemon = await startTrackedDaemon(stateDir);

    expect(Number((await readFile(paths.pidFilePath, "utf8")).trim())).toBe(process.pid);
    expect((await stat(paths.socketPath)).mode & 0o777).toBe(0o600);

    // Confirm the socket now actually answers RPC (proof the stale placeholder file was replaced).
    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.status" })}\n`);
    const response = JSON.parse(await reader.nextLine());
    expect(response.result.pid).toBe(process.pid);

    socket.destroy();
    void daemon;
    await rm(stateDir, { force: true, recursive: true });
  });

  test("config.json invalid values throw a clear error naming the key", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ wssPort: "not-a-number" }));

    await expect(startDaemon({ stateDir })).rejects.toThrow(/wssPort/u);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("config.json unknown keys warn instead of throwing", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ totallyUnknownKey: true, wssPort: 9000 }));

    const warnings: string[] = [];
    const daemon = await startTrackedDaemon(stateDir);
    void daemon;

    // Re-load directly to also exercise the warn callback in isolation from the running daemon.
    const { loadConfig } = await import("../daemon/config.js");
    const config = await loadConfig(getStateDirPaths(stateDir), {
      warn: (message) => warnings.push(message),
    });

    expect(config.wssPort).toBe(9000);
    expect(warnings.some((message) => message.includes("totallyUnknownKey"))).toBe(true);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("config.json iosBundleId is a known key, loaded as-is and validated as a non-empty string", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    const { loadConfig } = await import("../daemon/config.js");

    await writeFile(paths.configPath, JSON.stringify({ iosBundleId: "com.example.playground" }));

    const warnings: string[] = [];
    const config = await loadConfig(paths, { warn: (message) => warnings.push(message) });

    expect(config.iosBundleId).toBe("com.example.playground");
    // A key that warned as unknown would still "work" via the `--bundle-id` flag, hiding a typo'd
    // config from the operator for as long as they only ever passed the flag.
    expect(warnings).toEqual([]);

    await writeFile(paths.configPath, JSON.stringify({ iosBundleId: "" }));
    await expect(loadConfig(paths)).rejects.toThrow(/iosBundleId/u);

    await writeFile(paths.configPath, JSON.stringify({ iosBundleId: 42 }));
    await expect(loadConfig(paths)).rejects.toThrow(/iosBundleId/u);

    await writeFile(paths.configPath, JSON.stringify({ iosBundleId: "com.example.my-app2" }));
    await expect(loadConfig(paths)).resolves.toMatchObject({ iosBundleId: "com.example.my-app2" });

    // Deliberately *not* charset-checked here, only where the value is used. This loader runs on
    // every daemon start, so a typo in a CLI-side convenience key must not stop the daemon from
    // starting — it surfaces as a usage error against the `link`/`connect` call that needed it.
    await writeFile(paths.configPath, JSON.stringify({ iosBundleId: "--console" }));
    await expect(loadConfig(paths)).resolves.toMatchObject({ iosBundleId: "--console" });
    await expect(startTrackedDaemon(stateDir)).resolves.toBeDefined();

    await rm(stateDir, { force: true, recursive: true });
  });

  test("restartDaemonOnVersionMismatch defaults to false and must be a boolean", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    const { loadConfig } = await import("../daemon/config.js");
    await mkdir(stateDir, { recursive: true });

    // Absent: the safe default — never drop an operator's live sessions without being asked.
    await writeFile(paths.configPath, JSON.stringify({}));
    expect((await loadConfig(paths)).restartDaemonOnVersionMismatch).toBe(false);

    await writeFile(paths.configPath, JSON.stringify({ restartDaemonOnVersionMismatch: true }));
    expect((await loadConfig(paths)).restartDaemonOnVersionMismatch).toBe(true);

    // A string is the likely typo (`"true"`), and silently reading it as truthy would be the worst
    // possible failure for a knob whose whole job is guarding session loss.
    await writeFile(paths.configPath, JSON.stringify({ restartDaemonOnVersionMismatch: "true" }));
    await expect(loadConfig(paths)).rejects.toThrow(/restartDaemonOnVersionMismatch/u);

    await rm(stateDir, { force: true, recursive: true });
  });
});

/**
 * Retention wiring (ARCHITECTURE.md §3, issue #32). The audit *policy* — which files are stale, how
 * the day boundary is computed — is covered by `audit-retention.test.ts`; what matters here is that
 * a real daemon actually runs it at startup, keeps running it on the daily seam, reports the
 * footprint over RPC, and does not leave the timer behind on shutdown.
 */
describe("daemon: audit retention", () => {
  /** Interval-only fake: `startDaemon` uses its `timers` seam solely for the daily audit sweep, so
   * everything else (session grace/keepalive, listener pre-claim) keeps running on real timers. */
  const createIntervalRecorder = (): {
    timers: TimerFns;
    intervals: Array<{ callback: () => void; ms: number; cleared: boolean }>;
  } => {
    const intervals: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];

    return {
      intervals,
      timers: {
        ...systemTimers,
        setInterval: (callback, ms) => {
          const record = { callback, ms, cleared: false };
          intervals.push(record);
          return record as unknown as IntervalHandle;
        },
        clearInterval: (handle) => {
          (handle as unknown as { cleared: boolean }).cleared = true;
        },
      },
    };
  };

  const writeDayFile = async (auditDir: string, stamp: string): Promise<void> => {
    await writeFile(path.join(auditDir, `${stamp}.jsonl`), "{}\n", { mode: 0o600 });
  };

  /** These tests are about the audit directory, not the wss listener, so they pin a free port
   * rather than inheriting the default 8443 — nothing here should fail because something else on
   * the machine happens to hold it. */
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

  /** Both sweeps are fire-and-forget (`void auditLogger.prune()`), so the assertion polls rather
   * than sleeping on a guessed duration. */
  const waitForAuditDir = async (auditDir: string, expected: string[]): Promise<void> => {
    const deadline = Date.now() + 2000;

    for (;;) {
      const names = (await readdir(auditDir)).sort();

      if (names.join(",") === expected.join(",") || Date.now() > deadline) {
        expect(names).toEqual(expected);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  test("prunes stale day files at startup, again on the daily timer, and clears the timer on shutdown", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(paths.auditDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ auditRetentionDays: 7, wssPort: await pickFreePort() }));

    await writeDayFile(paths.auditDir, "2026-09-05"); // today per the clock below
    await writeDayFile(paths.auditDir, "2026-08-01"); // stale at startup

    const { timers, intervals } = createIntervalRecorder();
    let now = new Date("2026-09-05T12:00:00.000Z");
    const daemon = await startDaemon({ stateDir, timers, clock: { now: () => now } });
    runningDaemons.push(daemon);

    await waitForAuditDir(paths.auditDir, ["2026-09-05.jsonl"]);

    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.ms).toBe(AUDIT_PRUNE_INTERVAL_MS);

    // A day later the daemon is still running and the sweep still fires — the file that was
    // "today" at startup is now stale enough to go.
    await writeDayFile(paths.auditDir, "2026-09-14");
    now = new Date("2026-09-14T12:00:00.000Z");
    intervals[0]!.callback();
    await waitForAuditDir(paths.auditDir, ["2026-09-14.jsonl"]);

    await daemon.shutdown();
    expect(intervals[0]!.cleared).toBe(true);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("daemon.status reports the audit footprint and the effective retention", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(paths.auditDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ auditRetentionDays: 45, wssPort: await pickFreePort() }));

    // Clock-injected, and the fixture's name is derived from it, for two reasons: the file must
    // be dated relative to the daemon's own idea of "today" rather than the calendar the suite
    // happens to run on, and naming it *today* makes it immune to the fire-and-forget startup
    // sweep that may still be in flight — today's file is the one file pruning can never take.
    const now = new Date("2026-09-05T12:00:00.000Z");
    const daemon = await startDaemon({ stateDir, clock: { now: () => now } });
    runningDaemons.push(daemon);

    const todayFile = `${now.toISOString().slice(0, 10)}.jsonl`;
    await writeFile(path.join(paths.auditDir, todayFile), "x".repeat(120), { mode: 0o600 });

    const socket = await connectRaw(daemon.paths.socketPath);
    const reader = createLineReader(socket);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.status", params: {} })}\n`);
    const response = JSON.parse(await reader.nextLine());

    expect(response.result.audit).toEqual({
      path: paths.auditDir,
      failedWrites: 0,
      failedPrunes: 0,
      retentionDays: 45,
      files: 1,
      bytes: 120,
    });

    socket.destroy();
    await rm(stateDir, { force: true, recursive: true });
  });

  test("daemon status degrades cleanly against a daemon that predates retention", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });

    // A daemon.status exactly as a pre-retention daemon answers it. A running daemon outlives the
    // CLI upgrade that would replace it, so this pairing is reachable in the field.
    const legacyDaemon = await startRpcServer({
      socketPath: paths.socketPath,
      dispatch: {
        "daemon.status": () => ({
          version: "0.6.0",
          pid: 4242,
          startedAt: "2026-09-01T00:00:00.000Z",
          wssPort: 8443,
          pinnedKeys: ["sha256/legacy"],
          sessions: [],
          policy: { default: "allow", destructive: "allow" },
          audit: { path: paths.auditDir, failedWrites: 3 },
        }),
      },
    });

    try {
      const result = await handleDaemonStatusCommand({ stateDir });

      if (!result.ok) {
        throw new Error(`Expected a successful daemon status result, got ${JSON.stringify(result)}`);
      }

      // Reported as absent, not as zero: the CLI was never told, and "0 files retained" would be
      // a different (and false) claim. Asserted as *missing keys* rather than as keys holding
      // `undefined`, since `toEqual` treats those as interchangeable and would pass just as
      // happily against a build that fabricated zeroes... no, worse: against one that read the
      // fields straight through and got `undefined` by accident. The distinction this test exists
      // to protect is the one `toHaveProperty` can see.
      expect(result.data.audit).not.toHaveProperty("failed_prunes");
      expect(result.data.audit).not.toHaveProperty("retention_days");
      expect(result.data.audit).not.toHaveProperty("files");
      expect(result.data.audit).not.toHaveProperty("bytes");
      expect(result.data.audit.path).toBe(paths.auditDir);
      expect(result.data.audit.failed_writes).toBe(3);
      expect(JSON.parse(JSON.stringify(result.data.audit))).toEqual({
        path: paths.auditDir,
        failed_writes: 3,
      });
      expect(result.data.daemon.version).toBe("0.6.0");
    } finally {
      await legacyDaemon.close();
    }

    await rm(stateDir, { force: true, recursive: true });
  });

  test("an invalid auditRetentionDays/daemonLogMaxBytes fails the daemon like any other config key", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });

    await writeFile(paths.configPath, JSON.stringify({ auditRetentionDays: 0 }));
    await expect(startDaemon({ stateDir })).rejects.toThrow(/auditRetentionDays.*positive integer/u);

    await writeFile(paths.configPath, JSON.stringify({ daemonLogMaxBytes: 1.5 }));
    await expect(startDaemon({ stateDir })).rejects.toThrow(/daemonLogMaxBytes.*positive integer/u);

    await rm(stateDir, { force: true, recursive: true });
  });
});
