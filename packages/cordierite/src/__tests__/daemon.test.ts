import { spawnSync } from "node:child_process";
import { connect, type Socket } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { DaemonAlreadyRunningError } from "../daemon/pidfile.js";
import { startRpcServer } from "../daemon/rpc-server.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
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
});
