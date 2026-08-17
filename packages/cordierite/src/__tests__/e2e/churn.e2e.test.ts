/**
 * E2E scenario: churn.
 *
 * claim -> `dropSocket()` -> `ls` shows SUSPENDED -> `invoke` fails `session_suspended` ->
 * `resume()` -> `invoke` succeeds -> grace expiry (short configured grace) -> EXPIRED and alias
 * freed. This is the "survive churn" goal from ARCHITECTURE.md §1 exercised end-to-end.
 *
 * Grace expiry is synchronized on the daemon's own `session_expired` event (via a raw UDS
 * subscription used only for test synchronization, never to drive the scenario) rather than a
 * sleep, per the task's flake-resistance requirement.
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

describe("e2e: churn", () => {
  test(
    "suspend on socket loss, session_suspended on invoke, resume, then grace expiry frees the alias",
    async () => {
      const { stateDir, port } = await makeTempStateDir({ graceSeconds: 2 });
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);

      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8" });
      const alias = ack.alias;

      app.registerTools([{ name: "echo" }]);
      await events.waitFor("tools_changed");

      // Socket loss (network flap / crash) -> SUSPENDED.
      const suspended = events.waitFor("session_suspended");
      app.dropSocket();
      await suspended;

      const suspendedLs = await runCliJson<Array<{ alias: string; state: string }>>(["ls"], stateDir);
      expect(suspendedLs.ok).toBe(true);
      expect(suspendedLs.data).toEqual([expect.objectContaining({ alias, state: "suspended" })]);

      // A call against a SUSPENDED session fails fast with session_suspended, not a timeout.
      const failedInvoke = await runCliJson(["invoke", alias, "echo", "--input", "{}"], stateDir);
      expect(failedInvoke.ok).toBe(false);
      expect(failedInvoke.error?.type).toBe("session_suspended");

      // Resume within the grace window -> ACTIVE again, with a fresh registry snapshot required.
      const resumed = events.waitFor("session_resumed");
      await app.resume();
      await resumed;

      app.registerTools([{ name: "echo" }]);
      await events.waitFor("tools_changed");

      app.answerCalls(() => ({ result: "ok-after-resume" }));
      const resumedInvoke = await runCliJson(["invoke", alias, "echo", "--input", "{}"], stateDir);
      expect(resumedInvoke.ok).toBe(true);
      expect(resumedInvoke.data).toBe("ok-after-resume");

      // Drop again and let the (short, configured) grace window elapse -> EXPIRED, alias freed.
      const suspendedAgain = events.waitFor("session_suspended");
      app.dropSocket();
      await suspendedAgain;

      const expired = events.waitFor("session_expired");
      await expired;

      const afterExpiryLs = await runCliJson<unknown[]>(["ls"], stateDir);
      expect(afterExpiryLs.ok).toBe(true);
      expect(afterExpiryLs.data).toEqual([]);

      // The alias is free: a fresh claim from a same-model device reuses it rather than getting a
      // "-2" suffix (ARCHITECTURE.md §6: "terminal states free the alias").
      const freshLink = await mintLink(stateDir);
      const freshApp = new FakeAppClient(port, pinnedKeys);
      const freshAck = await freshApp.claim(freshLink, { model: "Pixel 8" });
      expect(freshAck.alias).toBe(alias);

      freshApp.close();
      events.close();
    },
    20_000,
  );
});
