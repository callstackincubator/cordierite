/**
 * Task 16 scenario: hostility — "the v1 killer scenario." While a session is ACTIVE, the daemon is
 * hit with a raw TLS connect/disconnect, an oversized (300 KiB) frame, a binary frame, garbage
 * JSON, and a wrong-token claim. None of it may crash the daemon (v1's exact defect: an unhandled
 * socket `'error'` took the whole process down); the ACTIVE session must keep invoking successfully
 * afterward, and the daemon must still be the *same* process (not silently restarted).
 */

import { connect as tlsConnect } from "node:tls";

import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";

import { FakeAppClient } from "./app-client.js";
import {
  cleanupAfterEach,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  runCliJson,
  subscribeToEvents,
} from "./harness.js";

afterEach(cleanupAfterEach);

const connectRawSocket = (port: number): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
};

const waitForClose = (socket: WebSocket): Promise<{ code: number; reason: string }> => {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
};

describe("e2e: hostility", () => {
  test(
    "the daemon survives a raw TLS flap, an oversized frame, a binary frame, garbage JSON, and a bad claim — ACTIVE session keeps invoking",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      const daemonPid = await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8" });
      const alias = ack.alias;
      const toolsChanged = events.waitFor("tools_changed");
      app.registerTools([{ name: "echo" }]);
      await toolsChanged;
      events.close();

      // 1. A raw TLS client connects then disconnects without ever speaking the app protocol.
      await new Promise<void>((resolve, reject) => {
        const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });

      // 2. A 300 KiB frame — over the 256 KiB wire limit (ARCHITECTURE.md §7).
      const oversized = await connectRawSocket(port);
      const oversizedClosed = waitForClose(oversized);
      oversized.send(JSON.stringify({ type: "session_claim", padding: "x".repeat(300 * 1024) }));
      await oversizedClosed;

      // 3. A binary frame -> close 1003.
      const binary = await connectRawSocket(port);
      const binaryClosed = waitForClose(binary);
      binary.send(Buffer.from([1, 2, 3, 4, 5]));
      const binaryCloseInfo = await binaryClosed;
      expect(binaryCloseInfo.code).toBe(1003);

      // 4. Garbage JSON -> close 1008 invalid_json.
      const garbage = await connectRawSocket(port);
      const garbageClosed = waitForClose(garbage);
      garbage.send("{ this is not json");
      const garbageCloseInfo = await garbageClosed;
      expect(garbageCloseInfo.code).toBe(1008);
      expect(garbageCloseInfo.reason).toBe("invalid_json");

      // 5. A wrong-token claim against a freshly minted (still-valid) link -> close 1008 invalid_token.
      const badClaimLink = await mintLink(stateDir);
      const badClaim = await connectRawSocket(port);
      const badClaimClosed = waitForClose(badClaim);
      badClaim.send(
        JSON.stringify({
          type: "session_claim",
          protocol_version: 2,
          session_id: badClaimLink.sessionId,
          token: "clearly-the-wrong-token",
        }),
      );
      const badClaimCloseInfo = await badClaimClosed;
      expect(badClaimCloseInfo.code).toBe(1008);
      expect(badClaimCloseInfo.reason).toBe("invalid_token");

      // The daemon is still the same process — none of the above crashed it.
      const statusAfter = await runCliJson<{ daemon: { pid: number } }>(["daemon", "status"], stateDir);
      expect(statusAfter.ok).toBe(true);
      expect(statusAfter.data!.daemon.pid).toBe(daemonPid);

      // The ACTIVE session, untouched by any of the hostile connections, keeps invoking successfully.
      app.answerCalls((call) => ({ result: { echoed: (call.args as Record<string, unknown>).text } }));
      const invokeResult = await runCliJson(
        ["invoke", alias, "echo", "--input", JSON.stringify({ text: "still-alive" })],
        stateDir,
      );
      expect(invokeResult.ok).toBe(true);
      expect(invokeResult.data).toEqual({ echoed: "still-alive" });

      app.close();
    },
    20_000,
  );
});
