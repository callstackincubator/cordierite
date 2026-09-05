import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import {
  callDaemon,
  DaemonUnavailableError,
  DaemonVersionMismatchError,
  openDaemonStream,
  resetDaemonVersionChecks,
  type SpawnFn,
} from "../rpc/client.js";
import { writeTestHostKey } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];
const fakeDaemons: FakeDaemon[] = [];

afterEach(async () => {
  while (fakeDaemons.length > 0) {
    await fakeDaemons.pop()?.stop();
  }

  while (runningDaemons.length > 0) {
    const daemon = runningDaemons.pop();
    await daemon?.shutdown();
  }

  resetDaemonVersionChecks();
});

const makeTempStateDir = async (): Promise<string> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-rpc-client-test-"));
  await writeTestHostKey(path.join(stateDir, "key.pem"));
  return stateDir;
};

// ---------------------------------------------------------------------------------------------
// A minimal stand-in daemon for the version-drift cases (issue #30)
// ---------------------------------------------------------------------------------------------

/**
 * Speaks just enough of the control-socket protocol (`daemon.status`, `daemon.shutdown`, NDJSON
 * JSON-RPC over the UDS, plus a pidfile) to exercise the client's version check. A *real*
 * `startDaemon` can only ever report this build's own version, and producing a live session for
 * the "unsafe to restart" case would need a full TLS + WebSocket claim — both of which belong to
 * the e2e suite. Here the point is the client's decision logic, so the daemon side is a fixture
 * whose version and session count the test dictates outright.
 */
type FakeDaemon = {
  /** Identifies which daemon answered a call, the way a real pid would. */
  readonly id: number;
  readonly statusCalls: () => number;
  readonly shutdownCalls: () => number;
  readonly stop: () => Promise<void>;
};

let nextFakeDaemonId = 1;

const startFakeDaemon = async (
  stateDir: string,
  options: { version: string; sessionCount?: number },
): Promise<FakeDaemon> => {
  const paths = getStateDirPaths(stateDir);
  const id = nextFakeDaemonId;
  nextFakeDaemonId += 1;

  let statusCalls = 0;
  let shutdownCalls = 0;
  let stopped = false;
  const sockets = new Set<Socket>();

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;

    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Mirrors the real teardown order (daemon.ts's `shutdown`): the pidfile is released after the
    // listener is gone, which is exactly the window the client's "is it really gone?" poll covers.
    await rm(paths.pidFilePath, { force: true });
    await rm(paths.socketPath, { force: true });
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});

    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (line.length === 0) {
          continue;
        }

        const request = JSON.parse(line) as { id: number; method: string };
        let result: unknown;

        if (request.method === "daemon.status") {
          statusCalls += 1;
          result = {
            version: options.version,
            pid: id,
            startedAt: new Date(0).toISOString(),
            wssPort: 8443,
            pinnedKeys: [],
            sessions: Array.from({ length: options.sessionCount ?? 0 }, (_unused, index) => ({
              sessionId: `session-${index}`,
              alias: `alias-${index}`,
              state: "active",
              device: {},
              createdAt: new Date(0).toISOString(),
              toolCount: 0,
            })),
            policy: { default: "allow", destructive: "allow" },
            audit: { path: paths.auditDir, failedWrites: 0 },
          };
        } else if (request.method === "daemon.shutdown") {
          shutdownCalls += 1;
          result = { ok: true };
        } else {
          result = { answeredBy: id };
        }

        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);

        if (request.method === "daemon.shutdown") {
          // The real daemon answers first and tears down afterwards (`context.afterSend`), so the
          // client must not assume the socket is dead the moment the reply lands.
          setTimeout(() => void stop(), 10);
        }
      }
    });
  });

  await rm(paths.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => resolve());
  });
  await writeFile(paths.pidFilePath, `${process.pid}\n`, "utf8");

  const handle: FakeDaemon = {
    id,
    statusCalls: () => statusCalls,
    shutdownCalls: () => shutdownCalls,
    stop,
  };

  fakeDaemons.push(handle);
  return handle;
};

describe("callDaemon", () => {
  test("connects directly when a daemon is already listening", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startDaemon({ stateDir });
    runningDaemons.push(daemon);

    const status = await callDaemon<{ pid: number }>(
      "daemon.status",
      {},
      { stateDir, autoSpawn: false },
    );

    expect(status.pid).toBe(process.pid);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("propagates a JSON-RPC error for an unknown method", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startDaemon({ stateDir });
    runningDaemons.push(daemon);

    await expect(
      callDaemon("nonexistent.method", {}, { stateDir, autoSpawn: false }),
    ).rejects.toThrow(/Method not found/u);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("without autoSpawn, a missing daemon fails fast instead of spawning", async () => {
    const stateDir = await makeTempStateDir();

    await expect(callDaemon("daemon.status", {}, { stateDir, autoSpawn: false })).rejects.toThrow();

    await rm(stateDir, { force: true, recursive: true });
  });

  test("auto-spawns an in-process daemon via the injected spawn fn and retries the request", async () => {
    const stateDir = await makeTempStateDir();
    let spawnCalls = 0;

    const spawn: SpawnFn = async (args, context) => {
      spawnCalls += 1;
      expect(args).toEqual(["daemon", "run"]);
      expect(context.stateDir).toBe(stateDir);

      const daemon = await startDaemon({ stateDir: context.stateDir });
      runningDaemons.push(daemon);
    };

    const status = await callDaemon<{ pid: number }>(
      "daemon.status",
      {},
      { stateDir, autoSpawn: true, spawn, spawnPollIntervalMs: 20, spawnWaitTimeoutMs: 2000 },
    );

    expect(spawnCalls).toBe(1);
    expect(status.pid).toBe(process.pid);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("concurrent auto-spawn race results in exactly one spawn (spawn-lock)", async () => {
    const stateDir = await makeTempStateDir();
    let spawnCalls = 0;

    const spawn: SpawnFn = async (_args, context) => {
      spawnCalls += 1;
      // Simulate real spawn latency so both callers are genuinely racing.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const daemon = await startDaemon({ stateDir: context.stateDir });
      runningDaemons.push(daemon);
    };

    const options = {
      stateDir,
      autoSpawn: true,
      spawn,
      spawnPollIntervalMs: 20,
      spawnWaitTimeoutMs: 3000,
    } as const;

    const [first, second] = await Promise.all([
      callDaemon<{ pid: number }>("daemon.status", {}, options),
      callDaemon<{ pid: number }>("daemon.status", {}, options),
    ]);

    expect(spawnCalls).toBe(1);
    expect(first.pid).toBe(process.pid);
    expect(second.pid).toBe(process.pid);
    expect(runningDaemons).toHaveLength(1);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("times out with DaemonUnavailableError when the spawned daemon never comes up", async () => {
    const stateDir = await makeTempStateDir();
    const spawn: SpawnFn = () => {
      // Deliberately never starts a daemon.
    };

    await expect(
      callDaemon(
        "daemon.status",
        {},
        { stateDir, autoSpawn: true, spawn, spawnPollIntervalMs: 20, spawnWaitTimeoutMs: 150 },
      ),
    ).rejects.toThrow(DaemonUnavailableError);

    await rm(stateDir, { force: true, recursive: true });
  });
});

describe("openDaemonStream", () => {
  test("supports calls and delivers server-pushed notifications", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startDaemon({ stateDir });
    runningDaemons.push(daemon);

    const stream = await openDaemonStream({ stateDir, autoSpawn: false });

    try {
      const status = await stream.call<{ pid: number }>("daemon.status");
      expect(status.pid).toBe(process.pid);

      const received: unknown[] = [];
      const unsubscribe = stream.onNotification((payload) => {
        received.push(payload);
      });

      const [connection] = daemon.server.connections();
      expect(connection).toBeDefined();
      daemon.server.notify(connection!, { kind: "daemon_started", ts: 123, data: null });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toEqual([{ kind: "daemon_started", ts: 123, data: null }]);

      unsubscribe();
    } finally {
      stream.close();
    }

    await rm(stateDir, { force: true, recursive: true });
  });
});

describe("daemon version check (issue #30)", () => {
  const CLIENT_VERSION = "9.9.9";
  const OLD_VERSION = "0.5.0";

  /** Shared knobs: short polls so the restart's "wait until it is really gone" loop is quick. */
  const timing = { spawnPollIntervalMs: 10, spawnWaitTimeoutMs: 3000, requestTimeoutMs: 3000 } as const;

  test("a daemon on the same version is left alone", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startFakeDaemon(stateDir, { version: CLIENT_VERSION });

    const result = await callDaemon<{ answeredBy: number }>(
      "sessions.list",
      {},
      { stateDir, autoSpawn: false, ...timing, checkVersion: { clientVersion: CLIENT_VERSION } },
    );

    expect(result.answeredBy).toBe(daemon.id);
    expect(daemon.shutdownCalls()).toBe(0);
    expect(daemon.statusCalls()).toBe(1);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("a mismatched idle daemon is replaced before the request is sent", async () => {
    const stateDir = await makeTempStateDir();
    const stale = await startFakeDaemon(stateDir, { version: OLD_VERSION });
    let replacement: FakeDaemon | undefined;

    const spawn: SpawnFn = async () => {
      replacement = await startFakeDaemon(stateDir, { version: CLIENT_VERSION });
    };

    const result = await callDaemon<{ answeredBy: number }>(
      "sessions.list",
      {},
      { stateDir, autoSpawn: true, spawn, ...timing, checkVersion: { clientVersion: CLIENT_VERSION } },
    );

    expect(stale.shutdownCalls()).toBe(1);
    expect(replacement).toBeDefined();
    // The command itself was answered by the *new* daemon: the check runs before the request, so
    // no caller ever gets a half-answer from the outgoing one.
    expect(result.answeredBy).toBe(replacement!.id);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("a mismatched daemon with live sessions is reported, not restarted", async () => {
    const stateDir = await makeTempStateDir();
    const stale = await startFakeDaemon(stateDir, { version: OLD_VERSION, sessionCount: 2 });

    const spawn: SpawnFn = () => {
      throw new Error("the daemon must not be replaced while sessions are live");
    };

    const error = await callDaemon(
      "sessions.list",
      {},
      { stateDir, autoSpawn: true, spawn, ...timing, checkVersion: { clientVersion: CLIENT_VERSION } },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DaemonVersionMismatchError);
    const mismatch = error as DaemonVersionMismatchError;
    expect(mismatch.daemonVersion).toBe(OLD_VERSION);
    expect(mismatch.clientVersion).toBe(CLIENT_VERSION);
    expect(mismatch.sessionCount).toBe(2);
    expect(mismatch.message).toContain("cordierite daemon stop");
    expect(mismatch.message).toContain("--daemon-restart");

    // The daemon the operator's sessions live on is untouched and still serving.
    expect(stale.shutdownCalls()).toBe(0);
    const stillThere = await callDaemon<{ answeredBy: number }>(
      "sessions.list",
      {},
      { stateDir, autoSpawn: false, ...timing },
    );
    expect(stillThere.answeredBy).toBe(stale.id);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("forceRestart replaces a mismatched daemon even with live sessions", async () => {
    const stateDir = await makeTempStateDir();
    const stale = await startFakeDaemon(stateDir, { version: OLD_VERSION, sessionCount: 1 });
    let replacement: FakeDaemon | undefined;

    const spawn: SpawnFn = async () => {
      replacement = await startFakeDaemon(stateDir, { version: CLIENT_VERSION });
    };

    const result = await callDaemon<{ answeredBy: number }>(
      "sessions.list",
      {},
      {
        stateDir,
        autoSpawn: true,
        spawn,
        ...timing,
        checkVersion: { clientVersion: CLIENT_VERSION, forceRestart: true },
      },
    );

    expect(stale.shutdownCalls()).toBe(1);
    expect(result.answeredBy).toBe(replacement!.id);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("concurrent calls share one check and one restart", async () => {
    const stateDir = await makeTempStateDir();
    const stale = await startFakeDaemon(stateDir, { version: OLD_VERSION });
    let spawnCalls = 0;
    let replacement: FakeDaemon | undefined;

    const spawn: SpawnFn = async () => {
      spawnCalls += 1;
      replacement = await startFakeDaemon(stateDir, { version: CLIENT_VERSION });
    };

    const options = {
      stateDir,
      autoSpawn: true,
      spawn,
      ...timing,
      checkVersion: { clientVersion: CLIENT_VERSION },
    } as const;

    const [first, second, third] = await Promise.all([
      callDaemon<{ answeredBy: number }>("sessions.list", {}, options),
      callDaemon<{ answeredBy: number }>("tools.list", {}, options),
      callDaemon<{ answeredBy: number }>("sessions.describe", {}, options),
    ]);

    expect(spawnCalls).toBe(1);
    expect(stale.shutdownCalls()).toBe(1);
    // One `daemon.status` for the whole process, not one per call — plus the single re-read the
    // restart does under the spawn-lock before it shuts the old daemon down.
    expect(stale.statusCalls()).toBe(2);
    expect([first.answeredBy, second.answeredBy, third.answeredBy]).toEqual([
      replacement!.id,
      replacement!.id,
      replacement!.id,
    ]);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("the check is skipped when nothing is listening and auto-spawn is off", async () => {
    const stateDir = await makeTempStateDir();

    // Nothing to drift from: any daemon this process spawns later is its own build. The check must
    // resolve rather than throw, so the command's own auto-spawn path still decides what happens.
    const error = await callDaemon(
      "sessions.list",
      {},
      { stateDir, autoSpawn: false, ...timing, checkVersion: { clientVersion: CLIENT_VERSION } },
    ).catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(DaemonVersionMismatchError);

    await rm(stateDir, { force: true, recursive: true });
  });

  test("openDaemonStream connects to the replacement, never to the outgoing daemon", async () => {
    const stateDir = await makeTempStateDir();
    const stale = await startFakeDaemon(stateDir, { version: OLD_VERSION });
    let replacement: FakeDaemon | undefined;

    const spawn: SpawnFn = async () => {
      replacement = await startFakeDaemon(stateDir, { version: CLIENT_VERSION });
    };

    const stream = await openDaemonStream({
      stateDir,
      autoSpawn: true,
      spawn,
      ...timing,
      checkVersion: { clientVersion: CLIENT_VERSION },
    });

    try {
      const answer = await stream.call<{ answeredBy: number }>("sessions.list");
      expect(answer.answeredBy).toBe(replacement!.id);
      expect(stale.shutdownCalls()).toBe(1);
    } finally {
      stream.close();
    }

    await rm(stateDir, { force: true, recursive: true });
  });
});
