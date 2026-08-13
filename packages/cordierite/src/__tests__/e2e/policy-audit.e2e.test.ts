/**
 * Policy/audit: destructive-deny + audit line assertions, driven through the real CLI subprocess
 * (a separate unit suite exercises the same policy/audit engine directly against the daemon's UDS
 * RPC; this drives the identical policy decision through `cordierite invoke`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { getStateDirPaths } from "../../daemon/state-dir.js";
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

type AuditRecord = {
  ts: string;
  sessionId: string;
  alias: string;
  tool: string;
  argsSha256: string;
  outcome: "ok" | "error" | "denied";
  errorType?: string;
  durationMs: number;
  caller: "cli" | "mcp";
};

const readTodaysAuditRecords = async (stateDir: string): Promise<AuditRecord[]> => {
  const paths = getStateDirPaths(stateDir);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const raw = await readFile(path.join(paths.auditDir, `${dateStamp}.jsonl`), "utf8");

  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
};

describe("e2e: policy and audit", () => {
  test(
    "a destructive-hinted tool is denied by policy via `cordierite invoke`, and every attempt is audited without raw args",
    async () => {
      const { stateDir, port } = await makeTempStateDir({ policy: { destructive: "deny" } });
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8" });
      const alias = ack.alias;

      const toolsChanged = events.waitFor("tools_changed");
      app.registerTools([
        { name: "echo" },
        { name: "deleteAll", annotations: { destructiveHint: true } },
      ]);
      await toolsChanged;
      events.close();

      app.answerCalls(() => ({ result: "ok" }));

      const sentinelSecret = "sentinel-secret-should-never-appear-in-audit-log";
      const okInvoke = await runCliJson(
        ["invoke", alias, "echo", "--input", JSON.stringify({ secret: sentinelSecret })],
        stateDir,
      );
      expect(okInvoke.ok).toBe(true);

      const deniedInvoke = await runCliJson(["invoke", alias, "deleteAll", "--input", "{}"], stateDir);
      expect(deniedInvoke.ok).toBe(false);
      expect(deniedInvoke.error?.type).toBe("policy_denied");
      // The hint names the config file the operator would edit to change this (ARCHITECTURE.md §12).
      expect(deniedInvoke.error?.details).toMatchObject({ hint: expect.stringContaining("config.json") });

      const records = await readTodaysAuditRecords(stateDir);
      expect(records.length).toBeGreaterThanOrEqual(2);

      const rawAuditContents = await readFile(
        path.join(getStateDirPaths(stateDir).auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
        "utf8",
      );
      expect(rawAuditContents).not.toContain(sentinelSecret);

      for (const record of records) {
        expect(record.sessionId).toBe(app.sessionId);
        expect(record.alias).toBe(alias);
        expect(record.caller).toBe("cli");
        expect(record.argsSha256).toMatch(/^[0-9a-f]{64}$/u);
      }

      const okRecord = records.find((record) => record.tool === "echo" && record.outcome === "ok");
      expect(okRecord).toBeDefined();

      const deniedRecord = records.find((record) => record.tool === "deleteAll" && record.outcome === "denied");
      expect(deniedRecord).toBeDefined();

      app.close();
    },
    15_000,
  );
});
