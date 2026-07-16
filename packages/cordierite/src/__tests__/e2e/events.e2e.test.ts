/**
 * Task 16 scenario: events. `cordierite events --json` streams NDJSON; this drives the full
 * lifecycle through a real CLI subprocess and fake app client and asserts the subscriber sees
 * `session_claimed` -> `tools_changed` -> `app_event` -> `tool_call_started`/`tool_call_finished` ->
 * `session_suspended`, in that order, on one persistent `events --json` subprocess.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { FakeAppClient } from "./app-client.js";
import {
  cleanupAfterEach,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  runCliJson,
  spawnCli,
} from "./harness.js";

afterEach(cleanupAfterEach);

type CapturedLine = { kind: string; sessionId?: string; alias?: string; ts: string; data: unknown };

/** Reads NDJSON lines from a spawned `events --json` subprocess's stdout as they arrive. */
const collectLines = (proc: ReturnType<typeof spawnCli>): { lines: CapturedLine[]; stop: () => void } => {
  const lines: CapturedLine[] = [];
  let buffered = "";
  let stopped = false;

  (async () => {
    for await (const chunk of proc.stdout) {
      if (stopped) {
        return;
      }

      buffered += Buffer.from(chunk).toString("utf8");
      let newlineIndex = buffered.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");

        if (line.length > 0) {
          const parsed = JSON.parse(line) as CapturedLine;
          expect(parsed).toHaveProperty("kind");
          expect(parsed).toHaveProperty("ts");
          lines.push(parsed);
        }
      }
    }
  })();

  return { lines, stop: () => (stopped = true) };
};

/** Polls `lines` until one of `kind` is present, or throws after `timeoutMs`. */
const waitForKindInLines = async (lines: CapturedLine[], kind: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!lines.some((line) => line.kind === kind)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for a "${kind}" event line. Seen: ${JSON.stringify(lines.map((l) => l.kind))}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("e2e: events --json", () => {
  test(
    "NDJSON stream captures claim -> tools_changed -> app_event -> tool_call_started/finished -> suspended, in order",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const eventsProcess = spawnCli(["events", "--json"], stateDir);
      const { lines, stop } = collectLines(eventsProcess);

      // The subscriber must be attached before the claim fires, or `session_claimed` would be
      // missed outright; there is no stdout signal for "subscribed" (only `event` notifications are
      // printed), so a short settle window is unavoidable here — matching the accepted precedent in
      // events.integration.test.ts. Every event below is still awaited by content, not by sleeping.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8" });
      const alias = ack.alias;

      await waitForKindInLines(lines, "session_claimed");

      app.registerTools([{ name: "echo" }]);
      await waitForKindInLines(lines, "tools_changed");

      app.emitEvent("custom_event", { hello: "world" });
      await waitForKindInLines(lines, "app_event");

      app.answerCalls(() => ({ result: "ok" }));
      const invokeResult = await runCliJson(["invoke", alias, "echo", "--input", "{}"], stateDir);
      expect(invokeResult.ok).toBe(true);
      await waitForKindInLines(lines, "tool_call_started");
      await waitForKindInLines(lines, "tool_call_finished");

      app.dropSocket();
      await waitForKindInLines(lines, "session_suspended");

      const kinds = lines.map((line) => line.kind);
      const indexOf = (kind: string): number => kinds.indexOf(kind);

      expect(indexOf("session_claimed")).toBeLessThan(indexOf("tools_changed"));
      expect(indexOf("tools_changed")).toBeLessThan(indexOf("app_event"));
      expect(indexOf("app_event")).toBeLessThan(indexOf("tool_call_started"));
      expect(indexOf("tool_call_started")).toBeLessThan(indexOf("tool_call_finished"));
      expect(indexOf("tool_call_finished")).toBeLessThan(indexOf("session_suspended"));

      stop();
      eventsProcess.kill("SIGINT");
      const exitCode = await eventsProcess.exited;
      expect(exitCode).toBe(0);
    },
    20_000,
  );
});
