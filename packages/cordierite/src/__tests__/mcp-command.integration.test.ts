/**
 * `cordierite mcp` command wiring (`commands/mcp.ts`): config's `scheme` reaches
 * `cordierite_connect` without an explicit override, and `stop()` tears the server down cleanly
 * (the transport-close path most other hosted commands rely on for graceful shutdown).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { decodeBootstrap } from "@cordierite/shared";

import { handleMcpCommand, type McpHostedResult } from "../commands/mcp.js";
import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { writeTestHostKey } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];
const hostedResults: McpHostedResult[] = [];

afterEach(async () => {
  while (hostedResults.length > 0) {
    hostedResults.pop()?.stop();
  }

  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (stateDirs.length > 0) {
    await rm(stateDirs.pop()!, { force: true, recursive: true });
  }
});

const failIfCalled = (): never => {
  throw new Error("auto-spawn should never be needed: the test daemon is already running.");
};

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

const startTestDaemon = async (extraConfig: Record<string, unknown> = {}): Promise<{ stateDir: string }> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-mcp-cmd-"));
  stateDirs.push(stateDir);
  await writeTestHostKey(path.join(stateDir, "key.pem"));

  const port = await pickFreePort();
  await writeFile(
    path.join(stateDir, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1", ...extraConfig }),
  );

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);

  return { stateDir };
};

/** Wires `handleMcpCommand` to an in-process stdio pair and drives it with a minimal hand-rolled
 * client transport (newline-delimited JSON, same framing as `StdioServerTransport`) — no
 * subprocess involved. */
const startMcpCommandWithClient = async (
  stateDir: string,
): Promise<{ hosted: McpHostedResult; client: Client }> => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  const hosted = await handleMcpCommand({
    stateDir,
    spawn: failIfCalled,
    stdin: clientToServer,
    stdout: serverToClient,
  });
  hostedResults.push(hosted);

  let onmessage: ((message: unknown) => void) | undefined;
  let readBuffer = "";
  serverToClient.on("data", (chunk: Buffer) => {
    readBuffer += chunk.toString("utf8");
    let newlineIndex = readBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = readBuffer.slice(0, newlineIndex);
      readBuffer = readBuffer.slice(newlineIndex + 1);
      newlineIndex = readBuffer.indexOf("\n");
      if (line.length > 0) {
        onmessage?.(JSON.parse(line));
      }
    }
  });

  const clientTransport = {
    start: async () => {},
    send: async (message: unknown) => {
      clientToServer.write(`${JSON.stringify(message)}\n`);
    },
    close: async () => {
      clientToServer.end();
    },
  };
  Object.defineProperty(clientTransport, "onmessage", {
    set(cb: (message: unknown) => void) {
      onmessage = cb;
    },
    get() {
      return onmessage;
    },
  });

  const client = new Client({ name: "test-mcp-command-client", version: "0.0.0" });
  await client.connect(clientTransport as never);

  return { hosted, client };
};

describe("cordierite mcp command", () => {
  test("cordierite_connect uses config.json's scheme when none is passed explicitly", async () => {
    const { stateDir } = await startTestDaemon({ scheme: "cordierite-test" });
    const { client } = await startMcpCommandWithClient(stateDir);

    // `target: "none"` keeps this about scheme resolution: this test drives the real `cordierite
    // mcp` binary, so there is no `exec` seam to inject, and a bare call would auto-detect against
    // whatever simulators the developer running the suite happens to have booted.
    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { deepLink: string };
    expect(data.deepLink.startsWith("cordierite-test:///?cordierite=")).toBe(true);

    const payload = data.deepLink.split("cordierite=")[1]!;
    expect(decodeBootstrap(payload)).not.toBeNull();
  });

  test("stop() tears the server down and resolves completion", async () => {
    const { stateDir } = await startTestDaemon({ scheme: "cordierite-test" });
    const { hosted } = await startMcpCommandWithClient(stateDir);

    hosted.stop();
    await hosted.completion;
  });
});
