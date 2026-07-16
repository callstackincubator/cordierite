/**
 * `cordierite events --json` (ARCHITECTURE.md §10, task 06 Testing section): "spawn the CLI as a
 * subprocess, assert line-delimited parseability." Drives a real daemon (auto-spawned by the first
 * CLI call) and a real `events` subprocess, asserts each stdout line is independently parseable
 * NDJSON, then confirms Ctrl-C (SIGINT) ends the stream cleanly (exit 0).
 */

import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runCliBinary, spawnCliBinary, waitForExit, writeTestHostKey } from "./fixtures.js";

const stateDirs: string[] = [];
const daemonPids: number[] = [];

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
    await rm(stateDirs.pop()!, { force: true, recursive: true });
  }
});

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

const makeTempStateDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "cordierite-events-cli-"));
  await writeTestHostKey(path.join(directory, "key.pem"));

  // A free-port config avoids EADDRINUSE collisions with the other test files' daemons that also
  // bind a wss listener concurrently when test files are run in parallel.
  const port = await pickFreePort();
  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1" }),
  );

  stateDirs.push(directory);
  return directory;
};

const runCliJson = (args: string[], stateDir: string) => {
  const result = runCliBinary([...args, "--json"], { stateDir });

  return JSON.parse(result.stdout);
};

describe("cordierite events --json", () => {
  test("streams NDJSON lines and exits 0 on SIGINT", async () => {
    const stateDir = await makeTempStateDir();

    // `daemon status` both auto-spawns the daemon and gives us its pid for cleanup.
    const status = runCliJson(["daemon", "status"], stateDir);
    expect(status.ok).toBe(true);
    daemonPids.push(status.data.daemon.pid);

    const eventsProcess = spawnCliBinary(["events", "--json"], { stateDir });

    const lines: string[] = [];
    let buffered = "";
    const linesSeen = new Promise<void>((resolve) => {
      (async () => {
        for await (const chunk of eventsProcess.stdout) {
          buffered += chunk.toString("utf8");
          let newlineIndex = buffered.indexOf("\n");

          while (newlineIndex !== -1) {
            const line = buffered.slice(0, newlineIndex);
            buffered = buffered.slice(newlineIndex + 1);

            if (line.length > 0) {
              lines.push(line);

              if (lines.length >= 1) {
                resolve();
              }
            }

            newlineIndex = buffered.indexOf("\n");
          }
        }
      })();
    });

    // Give the events subprocess a moment to connect and subscribe before minting the link that
    // should show up as a `link_created` notification.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const linkResult = runCliJson(["link", "--ttl", "30", "--scheme", "cordierite-events-test"], stateDir);
    expect(linkResult.ok).toBe(true);

    await Promise.race([
      linesSeen,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for an events line")), 5000)),
    ]);

    for (const line of lines) {
      // Every line must be independently parseable NDJSON — the core acceptance criterion.
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("kind");
      expect(parsed).toHaveProperty("ts");
    }

    expect(lines.some((line) => JSON.parse(line).kind === "link_created")).toBe(true);

    eventsProcess.kill("SIGINT");
    const exitCode = await waitForExit(eventsProcess);
    expect(exitCode).toBe(0);

    const stopResult = runCliJson(["daemon", "stop"], stateDir);
    expect(stopResult.ok).toBe(true);
  }, 15_000);
});
