/**
 * Task 16 scenario: cold start.
 *
 * `keygen --out` -> `link --json` (daemon auto-spawns) -> claim -> `ls` shows ACTIVE with alias ->
 * `tools`/`invoke` round-trip -> `revoke` -> `daemon stop` leaves no socket/pidfile.
 *
 * Every step is a real CLI subprocess (`runCliJson`) driving a real auto-spawned daemon, except the
 * claim itself, which is the scripted fake app client verifying the daemon's SPKI pin before
 * connecting (ARCHITECTURE.md §2/§7).
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FakeAppClient } from "./app-client.js";
import {
  cleanupAfterEach,
  decodeDeepLink,
  fetchPinnedKeys,
  makeTempStateDir,
  runCliJson,
  subscribeToEvents,
  trackDaemonPid,
  waitUntil,
} from "./harness.js";

afterEach(cleanupAfterEach);

describe("e2e: cold start", () => {
  test(
    "keygen -> link auto-spawns -> claim (pin-verified) -> ls ACTIVE -> tools/invoke -> revoke -> daemon stop leaves no socket/pidfile",
    async () => {
      const { stateDir, port } = await makeTempStateDir();

      // keygen: fully non-interactive, refuses to overwrite without --force.
      const keygenPath = path.join(stateDir, "operator-key.pem");
      const keygenResult = await runCliJson<{ path: string; pin: string }>(["keygen", "--out", keygenPath], stateDir);
      expect(keygenResult.ok).toBe(true);
      expect(keygenResult.data!.pin).toMatch(/^sha256\//u);

      // link: mints a pending session. This is the first command to touch the daemon, so it is the
      // one that auto-spawns it (ARCHITECTURE.md §4).
      const linkResult = await runCliJson<{ sessionId: string; deepLink: string; endpoint: { port: number } }>(
        ["link", "--ttl", "60"],
        stateDir,
      );
      expect(linkResult.ok).toBe(true);
      expect(linkResult.data!.deepLink.startsWith("cordierite-e2e:///?cordierite=")).toBe(true);
      expect(linkResult.data!.endpoint.port).toBe(port);
      const link = decodeDeepLink(linkResult.data!.deepLink);

      const statusResult = await runCliJson<{ daemon: { pid: number } }>(["daemon", "status"], stateDir);
      expect(statusResult.ok).toBe(true);
      trackDaemonPid(statusResult.data!.daemon.pid);

      // claim: the scripted app client verifies the daemon's SPKI pin (via daemon status's
      // pinned_keys) before trusting the connection at all — the same trust decision a real app
      // SDK makes.
      const pinnedKeys = await fetchPinnedKeys(stateDir);
      const events = await subscribeToEvents(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8", os: "Android 14" });
      expect(ack.status).toBe("ok");
      const alias = ack.alias;

      const toolsChanged = events.waitFor("tools_changed");
      app.registerTools([
        {
          name: "echo",
          description: "Echoes its input.",
          input_schema: { type: "object", properties: { text: { type: "string" } } },
        },
      ]);
      // Synchronizes on the daemon's own `tools_changed` event (raw UDS subscription, used only to
      // deterministically order this assertion — not to drive the scenario) rather than sleeping.
      await toolsChanged;

      // ls: the claimed session shows up ACTIVE with its device metadata and tool count.
      const lsResult = await runCliJson<Array<{ alias: string; state: string; toolCount: number }>>(["ls"], stateDir);
      expect(lsResult.ok).toBe(true);
      expect(lsResult.data).toHaveLength(1);
      expect(lsResult.data![0]!.alias).toBe(alias);
      expect(lsResult.data![0]!.state).toBe("active");
      expect(lsResult.data![0]!.toolCount).toBe(1);

      // tools: list, then detail by name.
      const toolsList = await runCliJson<Array<{ name: string }>>(["tools", alias], stateDir);
      expect(toolsList.ok).toBe(true);
      expect(toolsList.data!.map((tool) => tool.name)).toEqual(["echo"]);

      // invoke: round-trip through the fake app.
      app.answerCalls((call) => ({ result: { echoed: (call.args as Record<string, unknown>).text } }));

      const invokeResult = await runCliJson(
        ["invoke", alias, "echo", "--input", JSON.stringify({ text: "hello" })],
        stateDir,
      );
      expect(invokeResult.ok).toBe(true);
      expect(invokeResult.data).toEqual({ echoed: "hello" });

      // revoke: the session disappears from ls, and the app's socket is closed with code 1000.
      const revokeClosed = app.waitForClose();
      const revokeResult = await runCliJson(["revoke", alias], stateDir);
      expect(revokeResult.ok).toBe(true);
      const closeInfo = await revokeClosed;
      expect(closeInfo.code).toBe(1000);

      const finalLs = await runCliJson<unknown[]>(["ls"], stateDir);
      expect(finalLs.ok).toBe(true);
      expect(finalLs.data).toEqual([]);

      events.close();

      // daemon stop: no socket/pidfile survives it. The RPC response returns before teardown
      // finishes (`daemon.ts`'s shutdown runs in an `afterSend` callback), so this polls for the
      // files' actual removal instead of trusting a fixed delay.
      const stopResult = await runCliJson(["daemon", "stop"], stateDir);
      expect(stopResult.ok).toBe(true);

      const isGone = async (file: string): Promise<boolean> => {
        try {
          await stat(file);
          return false;
        } catch {
          return true;
        }
      };

      await waitUntil(() => isGone(path.join(stateDir, "daemon.sock")), { description: "daemon.sock removed" });
      await waitUntil(() => isGone(path.join(stateDir, "daemon.pid")), { description: "daemon.pid removed" });
    },
    20_000,
  );
});
