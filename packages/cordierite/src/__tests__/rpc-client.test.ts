import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { callDaemon, DaemonUnavailableError, openDaemonStream, type SpawnFn } from "../rpc/client.js";
import { writeTestHostKey } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    const daemon = runningDaemons.pop();
    await daemon?.shutdown();
  }
});

const makeTempStateDir = async (): Promise<string> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-rpc-client-test-"));
  await writeTestHostKey(path.join(stateDir, "key.pem"));
  return stateDir;
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
