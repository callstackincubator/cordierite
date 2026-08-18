/**
 * `cordierite events --json` (ARCHITECTURE.md §10): spawns the CLI as a subprocess and asserts
 * line-delimited parseability. Drives a real daemon (auto-spawned by the first
 * CLI call) and a real `events` subprocess, asserts each stdout line is independently parseable
 * NDJSON, then confirms Ctrl-C (SIGINT) ends the stream cleanly (exit 0).
 */

import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { decodeBootstrap } from "@cordierite/shared";

import { runCliBinary, spawnCliBinary, waitForExit, writeTestHostKey } from "./fixtures.js";

// Client pinning is the app's job; this test skips it client-side for its throwaway self-signed key.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

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

const makeTempStateDir = async (): Promise<{ stateDir: string; port: number }> => {
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
  return { stateDir: directory, port };
};

const runCliJson = (args: string[], stateDir: string) => {
  const result = runCliBinary([...args, "--json"], { stateDir });

  return JSON.parse(result.stdout);
};

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> => {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
};

/** Mints a link via the CLI, claims it over a fresh `ws` socket, and returns the claimed device's
 * identity plus the open socket (caller closes it). */
const claimAppOverCli = async (
  stateDir: string,
  port: number,
): Promise<{ socket: WebSocket; alias: string; sessionId: string }> => {
  const linkResult = runCliJson(["link", "--ttl", "30", "--scheme", "cordierite-events-since-test"], stateDir);
  expect(linkResult.ok).toBe(true);

  const payload = (linkResult.data.deepLink as string).split("cordierite=")[1]!.split("&")[0]!;
  const decoded = decodeBootstrap(payload)!;

  const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  socket.send(
    JSON.stringify({
      type: "session_claim",
      protocol_version: 2,
      session_id: decoded.sessionId,
      token: decoded.token,
      device_model: "Pixel 8",
    }),
  );
  const ack = await nextMessage(socket);

  return { socket, alias: ack.alias as string, sessionId: decoded.sessionId };
};

describe("cordierite events --json", () => {
  test("streams NDJSON lines and exits 0 on SIGINT", async () => {
    const { stateDir } = await makeTempStateDir();

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

  test("--since pulls retained events one-shot for a claimed session, and a later pull with the returned cursor sees nothing new", async () => {
    const { stateDir, port } = await makeTempStateDir();

    const status = runCliJson(["daemon", "status"], stateDir);
    expect(status.ok).toBe(true);
    daemonPids.push(status.data.daemon.pid);

    const { socket, alias, sessionId } = await claimAppOverCli(stateDir, port);
    socket.send(JSON.stringify({ type: "event", session_id: sessionId, name: "greeting", ts: Date.now() }));
    // The claim ack round-trip already guarantees `session_claimed` landed; give the `event` frame a
    // beat to reach the daemon and land in the retention buffer before pulling.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Attach the data listener before the process can exit — the child's stdout write and its
    // `process.exit()` race the parent's own read otherwise, and a `for await` started only once
    // the child has already exited can end up seeing nothing.
    const sinceProcess = spawnCliBinary(["events", alias, "--since", "0", "--json"], { stateDir });
    let stdout = "";
    sinceProcess.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    expect(await waitForExit(sinceProcess)).toBe(0);

    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(1); // at least one event line plus the trailing cursor line

    // The last line is the trailing `{"cursor":N}` marker (issue #6: a scripted caller shouldn't
    // have to reconstruct the resume point by maxing `seq` over the event lines, which is
    // impossible when the response is empty); everything before it is an event.
    const cursorLine = JSON.parse(lines[lines.length - 1]!) as { cursor: number };
    const eventLines = lines.slice(0, -1);

    for (const line of eventLines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("kind");
      expect(parsed).toHaveProperty("seq");
    }

    expect(eventLines.some((line) => JSON.parse(line).kind === "app_event")).toBe(true);

    const drainedProcess = spawnCliBinary(["events", alias, "--since", String(cursorLine.cursor), "--json"], { stateDir });
    let drainedStdout = "";
    drainedProcess.stdout.on("data", (chunk: Buffer) => {
      drainedStdout += chunk.toString("utf8");
    });
    expect(await waitForExit(drainedProcess)).toBe(0);

    // Nothing new since the cursor: only the trailing cursor line itself, no event lines.
    const drainedLines = drainedStdout.split("\n").filter((line) => line.length > 0);
    expect(drainedLines).toHaveLength(1);
    expect(JSON.parse(drainedLines[0]!)).toEqual({ cursor: cursorLine.cursor });

    socket.close();
    const stopResult = runCliJson(["daemon", "stop"], stateDir);
    expect(stopResult.ok).toBe(true);
  }, 15_000);
});
