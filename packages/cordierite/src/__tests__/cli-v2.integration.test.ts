/**
 * Task 06 acceptance criterion: "Command table of §10 works end-to-end against a real daemon in an
 * integration test (temp state dir): keygen -> daemon auto-spawn via `ls` -> link -> fake app client
 * claims -> `ls` shows the alias ACTIVE -> `tools`/`invoke` round-trip -> `revoke`." Every command
 * here runs as a real CLI subprocess (`bin.ts`) against a real daemon it auto-spawns, driven by a
 * scripted fake app client (`ws`) — the same harness pattern as
 * `tool-invocation.integration.test.ts`, just through the CLI instead of raw UDS RPC.
 */

import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { decodeBootstrap } from "@cordierite/shared";

import { spawnCliBinary, waitForExit, writeTestHostKey } from "./fixtures.js";

// The fake app client below skips pinning (that is the app SDK's job, exercised in
// session-engine.integration.test.ts); the leaf-cert check is disabled process-wide for this
// file's throwaway self-signed daemon key.
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

const makeTempStateDir = async (configOverrides: Record<string, unknown> = {}): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "cordierite-cli-v2-"));
  await writeTestHostKey(path.join(directory, "key.pem"));

  const port = await pickFreePort();
  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1", scheme: "cordierite-e2e", ...configOverrides }),
  );

  stateDirs.push(directory);
  return directory;
};

type CliJsonResult = { ok: boolean; data?: unknown; error?: { type: string; message: string } };

/**
 * Runs the CLI as a subprocess and returns its parsed `--json` output. It uses an async process:
 * several flows below (`invoke`) need the daemon to round-trip through this
 * test's own fake app WebSocket client while the CLI subprocess is in flight — `spawnSync` blocks
 * this process's event loop for the subprocess's entire lifetime, which would starve that
 * WebSocket's `message` handler and deadlock the round-trip.
 */
const runCliJson = async (args: string[], stateDir: string): Promise<CliJsonResult> => {
  const proc = spawnCliBinary([...args, "--json"], { stateDir });

  const [stdout, stderr] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
  ]);
  await waitForExit(proc);

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Failed to parse CLI JSON output for ${args.join(" ")}: ${(error as Error).message}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
};

const connectFakeApp = (port: number): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
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

describe("cordierite CLI v2: end-to-end command table", () => {
  test(
    "keygen -> ls auto-spawns -> link -> claim -> ls ACTIVE -> tools/invoke round-trip -> revoke",
    async () => {
      const stateDir = await makeTempStateDir();
      const port = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")).wssPort as number;

      // keygen: fully non-interactive, refuses to overwrite without --force.
      const keygenPath = path.join(stateDir, "operator-key.pem");
      const keygenResult = await runCliJson(["keygen", "--out", keygenPath], stateDir);
      expect(keygenResult.ok).toBe(true);
      expect((keygenResult.data as { pin: string }).pin).toMatch(/^sha256\//u);

      const keygenAgain = await runCliJson(["keygen", "--out", keygenPath], stateDir);
      expect(keygenAgain.ok).toBe(false);
      expect(keygenAgain.error?.type).toBe("usage_error");

      // ls: no sessions yet, and this is the call that auto-spawns the daemon.
      const firstLs = await runCliJson(["ls"], stateDir);
      expect(firstLs.ok).toBe(true);
      expect(firstLs.data).toEqual([]);

      const status = await runCliJson(["daemon", "status"], stateDir);
      expect(status.ok).toBe(true);
      daemonPids.push((status.data as { daemon: { pid: number } }).daemon.pid);

      // link: mint a pending session and decode its deep link.
      const linkResult = await runCliJson(["link", "--ttl", "60"], stateDir);
      expect(linkResult.ok).toBe(true);
      const linkData = linkResult.data as { sessionId: string; deepLink: string; endpoint: { port: number } };
      expect(linkData.deepLink.startsWith("cordierite-e2e:///?cordierite=")).toBe(true);
      expect(linkData.endpoint.port).toBe(port);

      const payload = linkData.deepLink.slice(linkData.deepLink.indexOf("cordierite=") + "cordierite=".length);
      const decoded = decodeBootstrap(payload);
      expect(decoded).not.toBeNull();

      // fake app client claims the link.
      const appSocket = await connectFakeApp(port);
      appSocket.send(
        JSON.stringify({
          type: "session_claim",
          protocol_version: 2,
          session_id: decoded!.sessionId,
          token: decoded!.token,
          device_model: "Pixel 8",
          device_os: "Android 14",
        }),
      );
      const ack = await nextMessage(appSocket);
      expect(ack.status).toBe("ok");
      const alias = ack.alias as string;

      appSocket.send(
        JSON.stringify({
          type: "tool_registry_snapshot",
          session_id: decoded!.sessionId,
          tools: [
            {
              name: "echo",
              description: "Echoes its input.",
              input_schema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        }),
      );
      // Give the snapshot a moment to land before the next CLI subprocess reads it.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // ls: the claimed session shows up ACTIVE with its device metadata and tool count.
      const secondLs = await runCliJson(["ls"], stateDir);
      expect(secondLs.ok).toBe(true);
      const sessions = secondLs.data as Array<{ alias: string; state: string; toolCount: number }>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.alias).toBe(alias);
      expect(sessions[0]!.state).toBe("active");
      expect(sessions[0]!.toolCount).toBe(1);

      // tools: list, then detail by name.
      const toolsList = await runCliJson(["tools", alias], stateDir);
      expect(toolsList.ok).toBe(true);
      expect((toolsList.data as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["echo"]);

      const toolsDetail = await runCliJson(["tools", alias, "echo"], stateDir);
      expect(toolsDetail.ok).toBe(true);
      expect((toolsDetail.data as { name: string; input_schema?: unknown }).input_schema).toEqual({
        type: "object",
        properties: { text: { type: "string" } },
      });

      // invoke: round-trip through the fake app.
      appSocket.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "tool_call") {
          appSocket.send(
            JSON.stringify({
              type: "tool_result",
              session_id: decoded!.sessionId,
              id: msg.id,
              result: { echoed: (msg.args as Record<string, unknown>).text },
            }),
          );
        }
      });

      const invokeResult = await runCliJson(
        ["invoke", alias, "echo", "--input", JSON.stringify({ text: "hello" })],
        stateDir,
      );
      expect(invokeResult.ok).toBe(true);
      expect(invokeResult.data).toEqual({ echoed: "hello" });

      // invoke a nonexistent tool: the wire error type is preserved verbatim.
      const invokeMissing = await runCliJson(["invoke", alias, "does-not-exist", "--input", "{}"], stateDir);
      expect(invokeMissing.ok).toBe(false);
      expect(invokeMissing.error?.type).toBe("tool_not_found");

      // revoke: the session disappears from ls.
      const revokeResult = await runCliJson(["revoke", alias], stateDir);
      expect(revokeResult.ok).toBe(true);
      expect(revokeResult.data).toEqual({ ok: true });

      const finalLs = await runCliJson(["ls"], stateDir);
      expect(finalLs.ok).toBe(true);
      expect(finalLs.data).toEqual([]);

      appSocket.close();

      const stopResult = await runCliJson(["daemon", "stop"], stateDir);
      expect(stopResult.ok).toBe(true);
    },
    20_000,
  );

  test(
    "ambiguous_session lists the live aliases so the user can retry with a selector",
    async () => {
      const stateDir = await makeTempStateDir();

      const status = await runCliJson(["daemon", "status"], stateDir);
      expect(status.ok).toBe(true);
      daemonPids.push((status.data as { daemon: { pid: number } }).daemon.pid);

      const port = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")).wssPort as number;

      const claimOne = async (deviceModel: string): Promise<{ socket: WebSocket; alias: string }> => {
        const linkResult = await runCliJson(["link", "--ttl", "60"], stateDir);
        const linkData = linkResult.data as { deepLink: string };
        const linkPayload = linkData.deepLink.slice(linkData.deepLink.indexOf("cordierite=") + "cordierite=".length);
        const decoded = decodeBootstrap(linkPayload)!;

        const socket = await connectFakeApp(port);
        socket.send(
          JSON.stringify({
            type: "session_claim",
            protocol_version: 2,
            session_id: decoded.sessionId,
            token: decoded.token,
            device_model: deviceModel,
          }),
        );
        const ack = await nextMessage(socket);
        return { socket, alias: ack.alias as string };
      };

      const first = await claimOne("Pixel 8");
      const second = await claimOne("Pixel 8");

      const toolsResult = await runCliJson(["tools"], stateDir);
      expect(toolsResult.ok).toBe(false);
      expect(toolsResult.error?.type).toBe("ambiguous_session");
      expect(toolsResult.error?.message).toContain(first.alias);
      expect(toolsResult.error?.message).toContain(second.alias);

      first.socket.close();
      second.socket.close();

      const stopResult = await runCliJson(["daemon", "stop"], stateDir);
      expect(stopResult.ok).toBe(true);
    },
    15_000,
  );
});
