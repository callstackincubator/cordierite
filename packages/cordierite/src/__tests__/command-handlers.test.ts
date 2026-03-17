import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { handleConnectCommand } from "../commands/connect.js";
import { handleSessionCommand } from "../commands/session.js";
import { createPayload, fixedClock } from "./fixtures.js";

describe("command handlers", () => {
  test("connect succeeds with a valid payload", () => {
    const result = handleConnectCommand(
      {
        payload: createPayload(),
      },
      { clock: fixedClock },
    );

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.data.bootstrap.endpoint.url).toBe("wss://192.168.1.42:8443");
      expect(result.data.bootstrap.can_claim).toBe(true);
    }
  });

  afterEach(() => {
    delete process.env.CORDIERITE_SESSIONS_DIR;
  });

  test("session reports empty list when no active host session is present", async () => {
    process.env.CORDIERITE_SESSIONS_DIR = path.join(
      tmpdir(),
      `cordierite-missing-session-test-${randomUUID()}`,
    );
    await mkdir(process.env.CORDIERITE_SESSIONS_DIR, { recursive: true });
    const result = await handleSessionCommand();

    expect(result).toEqual({
      ok: true,
      data: {
        sessions: [],
      },
    });
  });

  test("session lists registry entry and returns selected detail with --session-id", async () => {
    const sessionsDir = path.join(tmpdir(), `cordierite-session-test-${randomUUID()}`);
    process.env.CORDIERITE_SESSIONS_DIR = sessionsDir;
    await mkdir(sessionsDir, { recursive: true });

    const opaqueSessionId = "CmdHandlerTestSess01";

    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/session") {
        response.writeHead(200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            ok: true,
            data: {
              status: "active",
              session_id: opaqueSessionId,
              endpoint: {
                ip: "192.168.1.42",
                port: 8443,
                url: "wss://192.168.1.42:8443",
              },
            },
          }),
        );
        return;
      }

      response.writeHead(404, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ ok: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected test server to listen on a TCP port.");
    }

    await writeFile(
      path.join(sessionsDir, `${opaqueSessionId}.json`),
      `${JSON.stringify({
        sessionId: opaqueSessionId,
        controlPort: address.port,
        wssPort: 8443,
        ip: "192.168.1.42",
        pid: process.pid,
        registeredAt: fixedClock.now().toISOString(),
        lastSeenAt: fixedClock.now().toISOString(),
        status: "active",
        endpoint: {
          ip: "192.168.1.42",
          port: 8443,
          url: "wss://192.168.1.42:8443",
        },
        remoteTools: [],
      })}\n`,
      "utf8",
    );

    const result = await handleSessionCommand({ sessionId: opaqueSessionId });

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.sessions).toHaveLength(1);
    expect(result.data.selected).toEqual({
      session_id: opaqueSessionId,
      status: "active",
      control_port: address.port,
      wss_port: 8443,
      endpoint: {
        ip: "192.168.1.42",
        port: 8443,
        url: "wss://192.168.1.42:8443",
      },
      tool_count: 0,
    });
  });
});
