/**
 * E2E scenario: `cordierite invoke` + SIGINT (issue #9). SIGINT during an in-flight `tools.call`
 * must cancel the call rather than leave it running unowned in the app — this drives a real CLI
 * subprocess against a real daemon and fake app-client, the same harness as `events.e2e.test.ts`.
 */

import { afterEach, describe, expect, test } from "vitest";

import { FakeAppClient } from "./app-client.js";
import {
  cleanupAfterEach,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  spawnCli,
  waitForExit,
} from "./harness.js";

afterEach(cleanupAfterEach);

describe("e2e: cordierite invoke + SIGINT", () => {
  test(
    "SIGINT cancels the in-flight call: the app receives tool_cancel and the CLI exits non-zero as tool_cancelled",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8" });
      const alias = ack.alias;

      app.registerTools([{ name: "slow" }]);
      // Deliberately never call app.answerCalls(): the point of this scenario is that the app never
      // gets a chance to answer before the CLI gives up on it.

      const gotToolCall = app.waitForToolCall();
      const gotToolCancel = app.waitForToolCancel();

      const invokeProcess = spawnCli(["invoke", alias, "slow", "--input", "{}", "--json"], stateDir);
      // Drain stderr so the child never blocks on a full pipe buffer; stdout is collected below.
      invokeProcess.stderr.resume();
      const stdoutChunks: Buffer[] = [];
      invokeProcess.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

      await gotToolCall;
      invokeProcess.kill("SIGINT");

      const cancelFrame = await gotToolCancel;
      expect(cancelFrame.reason).toBe("connection_closed");

      const exitCode = await waitForExit(invokeProcess);
      expect(exitCode).toBe(72); // tool_error sysexits class (errors.ts's EXIT_CODE_BY_ERROR_TYPE)

      const rendered = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as {
        ok: boolean;
        error?: { type?: string };
      };
      expect(rendered.ok).toBe(false);
      expect(rendered.error?.type).toBe("tool_cancelled");
    },
    15_000,
  );
});
