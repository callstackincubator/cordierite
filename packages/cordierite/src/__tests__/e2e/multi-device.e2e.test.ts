/**
 * E2E scenario: multi-device.
 *
 * Two fake clients get distinct aliases; `invoke` without a selector errors `ambiguous_session`,
 * with an alias it works; `revoke` on one leaves the other untouched (ARCHITECTURE.md §1 goal 3:
 * "one daemon serves N concurrent device sessions on one port").
 */

import { afterEach, describe, expect, test } from "vitest";

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

describe("e2e: multi-device", () => {
  test(
    "distinct aliases, ambiguous_session without a selector, revoke isolates the other session",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);
      const events = await subscribeToEvents(stateDir);

      const claimDevice = async (model: string): Promise<{ app: FakeAppClient; alias: string }> => {
        const link = await mintLink(stateDir);
        const app = new FakeAppClient(port, pinnedKeys);
        const ack = await app.claim(link, { model });
        const toolsChanged = events.waitFor("tools_changed", (event) => event.alias === ack.alias);
        app.registerTools([{ name: "echo" }]);
        // Synchronizes on this device's own `tools_changed` event rather than sleeping.
        await toolsChanged;
        return { app, alias: ack.alias };
      };

      const deviceA = await claimDevice("Pixel 8");
      const deviceB = await claimDevice("Pixel 8");
      expect(deviceA.alias).not.toBe(deviceB.alias);

      const lsResult = await runCliJson<Array<{ alias: string }>>(["ls"], stateDir);
      expect(lsResult.ok).toBe(true);
      expect(lsResult.data!.map((session) => session.alias).sort()).toEqual([deviceA.alias, deviceB.alias].sort());

      // No selector, two live sessions: ambiguous_session, listing both aliases.
      const ambiguous = await runCliJson(["invoke", "echo", "--input", "{}"], stateDir);
      expect(ambiguous.ok).toBe(false);
      expect(ambiguous.error?.type).toBe("ambiguous_session");
      expect(ambiguous.error?.message).toContain(deviceA.alias);
      expect(ambiguous.error?.message).toContain(deviceB.alias);

      // With an explicit alias, invoke resolves to the right device.
      deviceA.app.answerCalls(() => ({ result: "from-a" }));
      deviceB.app.answerCalls(() => ({ result: "from-b" }));

      const invokeA = await runCliJson(["invoke", deviceA.alias, "echo", "--input", "{}"], stateDir);
      expect(invokeA.ok).toBe(true);
      expect(invokeA.data).toBe("from-a");

      const invokeB = await runCliJson(["invoke", deviceB.alias, "echo", "--input", "{}"], stateDir);
      expect(invokeB.ok).toBe(true);
      expect(invokeB.data).toBe("from-b");

      // revoke device A: its socket closes, but device B stays untouched and invokable.
      const revokeAClosed = deviceA.app.waitForClose();
      const revokeResult = await runCliJson(["revoke", deviceA.alias], stateDir);
      expect(revokeResult.ok).toBe(true);
      const closeInfo = await revokeAClosed;
      expect(closeInfo.code).toBe(1000);

      const afterRevokeLs = await runCliJson<Array<{ alias: string; state: string }>>(["ls"], stateDir);
      expect(afterRevokeLs.ok).toBe(true);
      expect(afterRevokeLs.data).toEqual([expect.objectContaining({ alias: deviceB.alias, state: "active" })]);

      const stillWorks = await runCliJson(["invoke", deviceB.alias, "echo", "--input", "{}"], stateDir);
      expect(stillWorks.ok).toBe(true);
      expect(stillWorks.data).toBe("from-b");

      deviceB.app.close();
      events.close();
    },
    20_000,
  );
});
