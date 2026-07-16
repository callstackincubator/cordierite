/**
 * Task 06 scope item 4: "Recreate an `exit-codes` test suite for the v2 commands (the v1 suite was
 * deleted with the v1 commands in task 01 ... its convention of asserting exact codes per failure
 * class is worth reproducing)." Each case here is a real CLI subprocess against a real daemon,
 * asserting both the exit code and the JSON error's `type`.
 */

import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { decodeBootstrap } from "@cordierite/shared";

import { runCliBinary, writeTestHostKey } from "./fixtures.js";

// The fake app client below skips pinning (that is the app SDK's job), so the leaf-cert check is
// disabled process-wide for this file's throwaway self-signed daemon key.
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

/** Always pins a free port: several cases below auto-spawn a real daemon, and the shared default
 * (8443) collides with the other test files' daemons when test files run concurrently. */
const makeTempStateDir = async (configOverrides: Record<string, unknown> = {}): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "cordierite-exit-codes-"));
  await writeTestHostKey(path.join(directory, "key.pem"));

  const port = await pickFreePort();
  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1", ...configOverrides }),
  );

  stateDirs.push(directory);
  return directory;
};

const runCli = (args: string[], stateDir: string) => {
  const result = runCliBinary([...args, "--json"], { stateDir });

  return {
    exitCode: result.exitCode,
    payload: JSON.parse(result.stdout),
  };
};

describe("exit codes: v2 command surface", () => {
  test("usage_error (64): an unknown command", async () => {
    const stateDir = await makeTempStateDir();
    const { exitCode, payload } = runCli(["not-a-real-command"], stateDir);

    expect(exitCode).toBe(64);
    expect(payload.error.type).toBe("usage_error");
  });

  test("usage_error (64): keygen refuses to overwrite without --force", async () => {
    const stateDir = await makeTempStateDir();
    const keyPath = path.join(stateDir, "existing.pem");

    const first = runCli(["keygen", "--out", keyPath], stateDir);
    expect(first.exitCode).toBe(0);

    const second = runCli(["keygen", "--out", keyPath], stateDir);
    expect(second.exitCode).toBe(64);
    expect(second.payload.error.type).toBe("usage_error");
  });

  test("validation_error (65): invoke --input is not valid JSON", async () => {
    const stateDir = await makeTempStateDir();
    const { exitCode, payload } = runCli(["invoke", "some-tool", "--input", "{not-json"], stateDir);

    expect(exitCode).toBe(65);
    expect(payload.error.type).toBe("validation_error");
  });

  test("connection_error (70): daemon stop against a never-started state dir", async () => {
    const stateDir = await makeTempStateDir();
    const { exitCode, payload } = runCli(["daemon", "stop"], stateDir);

    expect(exitCode).toBe(70);
    expect(payload.error.type).toBe("connection_error");
  });

  test("session_error (71): no_session when no device has ever connected", async () => {
    const stateDir = await makeTempStateDir();
    const { exitCode, payload } = runCli(["ls"], stateDir);
    expect(exitCode).toBe(0);
    expect(payload.data).toEqual([]);

    const status = runCli(["daemon", "status"], stateDir);
    daemonPids.push(status.payload.data.daemon.pid);

    const revokeResult = runCli(["revoke"], stateDir);
    expect(revokeResult.exitCode).toBe(71);
    expect(revokeResult.payload.error.type).toBe("no_session");
  });

  test("session_error (71): an unknown selector rejects with unknown_session (selector errors, not tool errors)", async () => {
    const stateDir = await makeTempStateDir();
    const status = runCli(["daemon", "status"], stateDir);
    daemonPids.push(status.payload.data.daemon.pid);

    const { exitCode, payload } = runCli(["invoke", "no-such-alias", "some-tool", "--input", "{}"], stateDir);

    expect(exitCode).toBe(71);
    expect(payload.error.type).toBe("unknown_session");
  });

  test("tool_error (72): invoke a name not registered on a real, claimed session", async () => {
    const port = await pickFreePort();
    const stateDir = await makeTempStateDir({ wssPort: port, advertisedIp: "127.0.0.1" });

    const status = runCli(["daemon", "status"], stateDir);
    daemonPids.push(status.payload.data.daemon.pid);

    const linkResult = runCli(["link", "--scheme", "cordierite-exit-codes"], stateDir);
    expect(linkResult.exitCode).toBe(0);

    const linkPayload = (linkResult.payload.data.deepLink as string).slice(
      (linkResult.payload.data.deepLink as string).indexOf("cordierite=") + "cordierite=".length,
    );
    const decoded = decodeBootstrap(linkPayload);
    expect(decoded).not.toBeNull();

    const appSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });

    const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
      appSocket.once("message", (data) => {
        try {
          resolve(JSON.parse(data.toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
      appSocket.send(
        JSON.stringify({
          type: "session_claim",
          protocol_version: 2,
          session_id: decoded!.sessionId,
          token: decoded!.token,
          device_model: "Pixel 8",
        }),
      );
    });
    const alias = ack.alias as string;

    const { exitCode, payload: invokeError } = runCli(
      ["invoke", alias, "does-not-exist", "--input", "{}"],
      stateDir,
    );

    expect(exitCode).toBe(72);
    expect(invokeError.error.type).toBe("tool_not_found");

    appSocket.close();
  }, 10_000);
});
