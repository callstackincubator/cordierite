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
  schemeOptions: {
    scheme?: string;
    cwd?: string;
    schemeEnv?: NodeJS.ProcessEnv;
    stderr?: Pick<NodeJS.WriteStream, "write">;
  } = {},
): Promise<{ hosted: McpHostedResult; client: Client }> => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  const hosted = await handleMcpCommand({
    stateDir,
    spawn: failIfCalled,
    stdin: clientToServer,
    stdout: serverToClient,
    // Scheme resolution is cwd-relative, so every test pins it explicitly rather than inheriting
    // whatever directory the suite happens to run from. `schemeEnv` (not `env`, which is the
    // adb/simctl environment) is likewise pinned so an exported CORDIERITE_SCHEME cannot leak in.
    cwd: schemeOptions.cwd ?? stateDir,
    schemeEnv: schemeOptions.schemeEnv ?? {},
    scheme: schemeOptions.scheme,
    stderr: schemeOptions.stderr,
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

  // Issue #29 acceptance: `cordierite mcp --scheme myapp` works with an empty state dir, so an MCP
  // config entry (`{"command":"cordierite","args":["mcp","--scheme","myapp"]}`) is self-contained.
  test("--scheme reaches cordierite_connect with no scheme in config.json", async () => {
    const { stateDir } = await startTestDaemon();
    const { client } = await startMcpCommandWithClient(stateDir, { scheme: "from-flag" });

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { deepLink: string }).deepLink).toMatch(
      /^from-flag:\/\/\/\?cordierite=/u,
    );
  });

  test("CORDIERITE_SCHEME reaches cordierite_connect with no scheme in config.json", async () => {
    const { stateDir } = await startTestDaemon();
    const { client } = await startMcpCommandWithClient(stateDir, {
      schemeEnv: { CORDIERITE_SCHEME: "from-env" },
    });

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { deepLink: string }).deepLink).toMatch(
      /^from-env:\/\/\/\?cordierite=/u,
    );
  });

  test("--scheme wins over config.json's scheme", async () => {
    const { stateDir } = await startTestDaemon({ scheme: "from-config" });
    const { client } = await startMcpCommandWithClient(stateDir, { scheme: "from-flag" });

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );

    expect((result.structuredContent as { deepLink: string }).deepLink).toMatch(
      /^from-flag:\/\/\/\?cordierite=/u,
    );
  });

  test("an app.json in the working directory is enough — no config file at all", async () => {
    const { stateDir } = await startTestDaemon();
    const appRoot = await mkdtemp(path.join(tmpdir(), "cordierite-mcp-app-"));
    stateDirs.push(appRoot);
    await writeFile(
      path.join(appRoot, "app.json"),
      JSON.stringify({ expo: { name: "Demo", scheme: "from-app-json" } }),
    );

    const { client } = await startMcpCommandWithClient(stateDir, { cwd: appRoot });

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );

    expect((result.structuredContent as { deepLink: string }).deepLink).toMatch(
      /^from-app-json:\/\/\/\?cordierite=/u,
    );
  });

  // The server must still start without a scheme (it is useful for proxying a session paired by
  // QR or `cordierite link`); only `cordierite_connect` fails, and it names where to put one.
  test("starts without any scheme and fails cordierite_connect with the locations tried", async () => {
    const { stateDir } = await startTestDaemon();
    const { client } = await startMcpCommandWithClient(stateDir);

    // The server started at all — this listing would have thrown if it had not.
    await expect(client.listTools()).resolves.toBeDefined();

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("CORDIERITE_SCHEME");
    expect(text).toContain("app.json");
    expect(text).toContain("cordierite init");
  });

  // A broken `app.json` in the working directory must not stop an MCP client from starting its
  // server — the failure is deferred to `cordierite_connect`, same as "no scheme at all".
  test("starts even when app.json in the working directory is malformed", async () => {
    const { stateDir } = await startTestDaemon();
    const appRoot = await mkdtemp(path.join(tmpdir(), "cordierite-mcp-badapp-"));
    stateDirs.push(appRoot);
    await writeFile(path.join(appRoot, "app.json"), "{ this is not json");

    // A resolution *error* (as opposed to simply finding nothing) is also reported on stderr at
    // startup, so an operator hears about a typo immediately rather than only when some agent
    // happens to call cordierite_connect. Never on stdout: that carries MCP frames only.
    let stderrText = "";
    const stderr = {
      write(chunk: string | Uint8Array) {
        stderrText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    } as unknown as Pick<NodeJS.WriteStream, "write">;

    const { client } = await startMcpCommandWithClient(stateDir, { cwd: appRoot, stderr });

    await expect(client.listTools()).resolves.toBeDefined();
    expect(stderrText).toContain("could not resolve a deep-link scheme");
    expect(stderrText).toContain("starting anyway");

    const result = await client.request(
      { method: "tools/call", params: { name: "cordierite_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("scheme resolution failed");
  });

  test("an invalid --scheme is reported on stderr but still starts the server", async () => {
    const { stateDir } = await startTestDaemon();

    let stderrText = "";
    const stderr = {
      write(chunk: string | Uint8Array) {
        stderrText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    } as unknown as Pick<NodeJS.WriteStream, "write">;

    const { client } = await startMcpCommandWithClient(stateDir, { scheme: "myapp://", stderr });

    await expect(client.listTools()).resolves.toBeDefined();
    expect(stderrText).toContain("Invalid deep-link scheme");
  });

  test("stop() tears the server down and resolves completion", async () => {
    const { stateDir } = await startTestDaemon({ scheme: "cordierite-test" });
    const { hosted } = await startMcpCommandWithClient(stateDir);

    hosted.stop();
    await hosted.completion;
  });
});
