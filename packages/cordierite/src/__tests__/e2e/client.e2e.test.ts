/**
 * E2E scenario: the `cordierite/client` programmatic API (issue #8). Drives a full session
 * lifecycle — claim, register tools, call a tool, wait for an app-pushed event, and a policy-denied
 * call — entirely through `connect()`/`AppClient`, never through a CLI subprocess, and asserts the
 * audit trail attributes these calls to `caller: "client"`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { connect, CordieriteError } from "../../client/index.js";
import { getStateDirPaths } from "../../daemon/state-dir.js";
import { FakeAppClient } from "./app-client.js";
import { cleanupAfterEach, ensureDaemon, fetchPinnedKeys, makeTempStateDir, mintLink, subscribeToEvents } from "./harness.js";

afterEach(cleanupAfterEach);

type AuditRecord = {
  sessionId: string;
  alias: string;
  tool: string;
  outcome: "ok" | "error" | "denied";
  caller: "cli" | "mcp" | "client";
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

/** A caller-declared tool map, `interface`-style (not a `type` alias) — regression coverage for
 * `AppClient<TTools>` being unconstrained so both forms type-check (a `Record<string, ...>`-bound
 * generic would reject this: TS only infers an implicit index signature for `type` aliases, not for
 * `interface`s). */
interface Tools {
  sum: { args: { a: number; b: number }; result: { total: number } };
  deleteAll: { args: Record<string, never>; result: string };
}

describe("e2e: cordierite/client", () => {
  test(
    "connect() -> tools() -> call() -> waitForEvent() round-trips against a real daemon and app, audited as caller \"client\"",
    async () => {
      const { stateDir, port } = await makeTempStateDir({ policy: { destructive: "deny" } });
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const fakeApp = new FakeAppClient(port, pinnedKeys);
      const ack = await fakeApp.claim(link, { model: "Pixel 8" });

      const toolsChanged = events.waitFor("tools_changed");
      fakeApp.registerTools([
        { name: "sum" },
        { name: "deleteAll", annotations: { destructiveHint: true } },
      ]);
      await toolsChanged;
      events.close();

      fakeApp.answerCalls((call) => {
        if (call.name === "sum") {
          const { a, b } = call.args as { a: number; b: number };
          return { result: { total: a + b } };
        }

        return { result: "ok" };
      });

      const app = await connect<Tools>({ stateDir, selector: link.sessionId });
      expect(app.sessionId).toBe(link.sessionId);

      const tools = await app.tools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["deleteAll", "sum"]);

      // Typed end to end: no cast needed for `.total` (regression coverage for the default
      // `ToolMap`'s `result: any` and the interface-based `Tools` map above).
      const { total } = await app.call("sum", { a: 2, b: 3 });
      expect(total).toBe(5);

      const waitingForEvent = app.waitForEvent<{ orderId: string }>("checkout_done", { timeoutMs: 5000 });
      fakeApp.emitEvent("checkout_done", { orderId: "42" });
      const event = await waitingForEvent;
      expect(event).toMatchObject({ name: "checkout_done", payload: { orderId: "42" } });

      await expect(app.call("no_such_tool" as never, {})).rejects.toMatchObject({ type: "tool_not_found" });
      await expect(app.call("deleteAll", {})).rejects.toMatchObject({ type: "policy_denied" });

      const records = (await readTodaysAuditRecords(stateDir)).filter((record) => record.alias === ack.alias);

      expect(records).toContainEqual(
        expect.objectContaining({ tool: "sum", outcome: "ok", caller: "client" }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({ tool: "no_such_tool", outcome: "error", caller: "client" }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({ tool: "deleteAll", outcome: "denied", caller: "client" }),
      );

      app.close();
      fakeApp.close();
    },
    15_000,
  );

  test(
    "call()'s transport timeout never fires before the daemon's own tool_timeout, even for a timeoutMs above the transport default",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const fakeApp = new FakeAppClient(port, pinnedKeys);
      await fakeApp.claim(link, { model: "Pixel 8" });

      const toolsChanged = events.waitFor("tools_changed");
      fakeApp.registerTools([{ name: "neverResponds" }]);
      await toolsChanged;
      events.close();
      // Deliberately never calls `answerCalls` — the daemon's own clamped tool_timeout must be
      // what ends this call, not this client's transport-level request timeout.

      const app = await connect({ stateDir, selector: link.sessionId });

      // Above the old hardcoded 10s transport default: before the fix this reliably surfaced as
      // `connection_error` ("Timed out waiting for a response to tools.call") instead of the
      // daemon's own `tool_timeout`.
      await expect(app.call("neverResponds", {}, { timeoutMs: 12_000 })).rejects.toMatchObject({
        type: "tool_timeout",
      });

      app.close();
      fakeApp.close();
    },
    20_000,
  );

  test("waitForEvent() rejects (rather than crashing the connection) when its match predicate throws", async () => {
    const { stateDir, port } = await makeTempStateDir();
    await ensureDaemon(stateDir);
    const pinnedKeys = await fetchPinnedKeys(stateDir);

    const events = await subscribeToEvents(stateDir);
    const link = await mintLink(stateDir);
    const fakeApp = new FakeAppClient(port, pinnedKeys);
    await fakeApp.claim(link, { model: "Pixel 8" });

    const toolsChanged = events.waitFor("tools_changed");
    fakeApp.registerTools([{ name: "echo" }]);
    await toolsChanged;
    events.close();
    fakeApp.answerCalls(() => ({ result: "ok" }));

    const app = await connect({ stateDir, selector: link.sessionId });

    const waiting = app.waitForEvent("boom", {
      timeoutMs: 5000,
      match: () => {
        throw new Error("predicate exploded");
      },
    });

    fakeApp.emitEvent("boom", { anything: true });
    await expect(waiting).rejects.toThrow("predicate exploded");

    // The connection must still be usable afterwards — a throwing listener must not have taken
    // down the socket's data handler for every other in-flight/future call.
    const result = await app.call("echo", {});
    expect(result).toBe("ok");

    app.close();
    fakeApp.close();
  });

  test(
    "waitForEvent() resolves from the retained buffer for an event emitted before it was called (no live-subscribe race)",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const fakeApp = new FakeAppClient(port, pinnedKeys);
      await fakeApp.claim(link, { model: "Pixel 8" });

      const toolsChanged = events.waitFor("tools_changed");
      fakeApp.registerTools([{ name: "echo" }]);
      await toolsChanged;
      events.close();
      fakeApp.answerCalls(() => ({ result: "ok" }));

      const app = await connect({ stateDir, selector: link.sessionId });

      // Emitted well before `waitForEvent` is ever called — a live-only subscription would miss
      // this entirely; the daemon's retention buffer is what lets this still resolve.
      fakeApp.emitEvent("checkout_done", { orderId: "already-happened" });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const event = await app.waitForEvent<{ orderId: string }>("checkout_done", { timeoutMs: 5000 });
      expect(event).toMatchObject({ name: "checkout_done", payload: { orderId: "already-happened" } });
      expect(typeof event.seq).toBe("number");

      app.close();
      fakeApp.close();
    },
    15_000,
  );

  test(
    "events() drains the retained buffer, and waitForEvent()'s since skips events already seen",
    async () => {
      const { stateDir, port } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const fakeApp = new FakeAppClient(port, pinnedKeys);
      await fakeApp.claim(link, { model: "Pixel 8" });

      const toolsChanged = events.waitFor("tools_changed");
      fakeApp.registerTools([{ name: "echo" }]);
      await toolsChanged;
      events.close();
      fakeApp.answerCalls(() => ({ result: "ok" }));

      const app = await connect({ stateDir, selector: link.sessionId });

      fakeApp.emitEvent("checkout_done", { orderId: "first" });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const drained = await app.events();
      expect(drained.events.map((event) => event.payload)).toContainEqual({ orderId: "first" });
      expect(drained.cursor).toBeGreaterThan(0);

      // With `since` set to the cursor already drained, a second wait must not re-resolve
      // instantly against the same "first" event — only a genuinely new one.
      const waitingForNext = app.waitForEvent<{ orderId: string }>("checkout_done", {
        timeoutMs: 5000,
        since: drained.cursor,
      });
      fakeApp.emitEvent("checkout_done", { orderId: "second" });
      const next = await waitingForNext;
      expect(next).toMatchObject({ payload: { orderId: "second" } });
      expect(next.seq).toBeGreaterThan(drained.cursor);

      app.close();
      fakeApp.close();
    },
    15_000,
  );

  test("connect() rejects with a connection_error CordieriteError when the daemon is unreachable and auto-spawn is disabled", async () => {
    const { stateDir } = await makeTempStateDir();

    await expect(connect({ stateDir, autoSpawn: false })).rejects.toBeInstanceOf(CordieriteError);
    await expect(connect({ stateDir, autoSpawn: false })).rejects.toMatchObject({ type: "connection_error" });
  });
});
