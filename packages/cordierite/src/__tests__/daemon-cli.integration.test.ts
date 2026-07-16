import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runCliBinary, spawnCliBinary, waitForExit, writeTestHostKey } from "./fixtures.js";

const stateDirs: string[] = [];
const daemonPids: number[] = [];

const makeTempStateDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "cordierite-daemon-cli-"));
  await writeTestHostKey(path.join(directory, "key.pem"));
  stateDirs.push(directory);
  return directory;
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  while (daemonPids.length > 0) {
    const pid = daemonPids.pop()!;
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  while (stateDirs.length > 0) {
    const directory = stateDirs.pop()!;
    await rm(directory, { force: true, recursive: true });
  }
});

const runDaemonCli = (args: string[], stateDir: string) => {
  return runCliBinary([...args, "--json"], { stateDir });
};

describe("daemon CLI (real subprocess)", () => {
  test("daemon stop against a never-started state dir fails cleanly (no crash, no bad SIGTERM)", async () => {
    const stateDir = await makeTempStateDir();

    const stopResult = runDaemonCli(["daemon", "stop"], stateDir);
    expect(stopResult.exitCode).not.toBe(0);

    const stopPayload = JSON.parse(stopResult.stdout);
    expect(stopPayload.ok).toBe(false);
    expect(stopPayload.error.type).toBe("connection_error");
    expect(stopPayload.error.message).toMatch(/No Cordierite daemon is running/u);
  }, 15_000);

  test("daemon status auto-spawns a daemon, then daemon stop tears it down", async () => {
    const stateDir = await makeTempStateDir();

    const statusResult = runDaemonCli(["daemon", "status"], stateDir);
    expect(statusResult.exitCode).toBe(0);

    const statusPayload = JSON.parse(statusResult.stdout);
    expect(statusPayload.ok).toBe(true);
    expect(statusPayload.data.daemon.pid).toBeGreaterThan(0);
    daemonPids.push(statusPayload.data.daemon.pid);

    expect((await stat(path.join(stateDir, "daemon.sock"))).mode & 0o777).toBe(0o600);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);

    const stopResult = runDaemonCli(["daemon", "stop"], stateDir);
    expect(stopResult.exitCode).toBe(0);

    const stopPayload = JSON.parse(stopResult.stdout);
    expect(stopPayload.ok).toBe(true);
    expect(stopPayload.data.daemon.method).toBe("rpc");

    // Give the async teardown a moment to remove the socket/pid files.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(stat(path.join(stateDir, "daemon.sock"))).rejects.toThrow();
    await expect(stat(path.join(stateDir, "daemon.pid"))).rejects.toThrow();
  }, 15_000);

  test("a second `daemon run` against an already-running state dir exits non-zero", async () => {
    const stateDir = await makeTempStateDir();

    const firstRun = spawnCliBinary(["daemon", "run", "--json"], { stateDir });

    try {
      const firstLine = await new Promise<string>((resolve) => {
        let buffered = "";
        (async () => {
          for await (const chunk of firstRun.stdout) {
            buffered += chunk.toString("utf8");
            if (buffered.includes("\n")) {
              resolve(buffered);
              return;
            }
          }
          resolve(buffered);
        })();
      });

      const firstPayload = JSON.parse(firstLine);
      expect(firstPayload.ok).toBe(true);
      daemonPids.push(firstPayload.data.daemon.pid);

      const secondRun = runDaemonCli(["daemon", "run"], stateDir);
      expect(secondRun.exitCode).not.toBe(0);

      const secondPayload = JSON.parse(secondRun.stdout);
      expect(secondPayload.ok).toBe(false);
      expect(secondPayload.error.type).toBe("connection_error");
      expect(secondPayload.error.message).toMatch(/already running/u);
    } finally {
      firstRun.kill("SIGTERM");
      await waitForExit(firstRun);
    }
  }, 15_000);
});
