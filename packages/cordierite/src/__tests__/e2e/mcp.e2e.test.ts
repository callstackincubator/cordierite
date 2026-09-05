/**
 * E2E scenario: MCP. An MCP client over stdio against a real `cordierite mcp` *subprocess*
 * (consolidating `mcp-server.integration.test.ts`'s in-process coverage at the subprocess level):
 * list/call/list_changed with the fake app.
 */

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { FakeAppClient } from "./app-client.js";
import {
  binEntry,
  cleanupAfterEach,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  packageRoot,
  subscribeToEvents,
  trackCleanup,
} from "./harness.js";

afterEach(cleanupAfterEach);

const BUILTIN_TOOL_NAMES = new Set([
  "cordierite_connect",
  "cordierite_wait_for_session",
  "cordierite_events",
  "cordierite_wait_for_event",
]);

const withoutBuiltinTools = <T extends { name: string }>(tools: T[]): T[] => {
  return tools.filter((tool) => !BUILTIN_TOOL_NAMES.has(tool.name));
};

describe("e2e: mcp (real stdio subprocess)", () => {
  test(
    "tools/list, tools/call, and list_changed against a real `cordierite mcp` subprocess",
    async () => {
      const { stateDir, port } = await makeTempStateDir({ scheme: "cordierite-mcp-e2e" });
      // The daemon is brought up first (via a real CLI subprocess) so the `mcp` subprocess never
      // needs to win an auto-spawn race with this test's own setup, and so the pin can be fetched
      // before the fake app ever connects.
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8" });
      const alias = ack.alias;
      const toolsChanged = events.waitFor("tools_changed");
      app.registerTools([
        {
          name: "echo",
          description: "Echoes its input.",
          input_schema: { type: "object", properties: { text: { type: "string" } } },
        },
      ]);
      await toolsChanged;
      events.close();

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [binEntry, "mcp"],
        cwd: packageRoot,
        env: { ...(process.env as Record<string, string>), CORDIERITE_STATE_DIR: stateDir },
        stderr: "pipe",
      });

      const client = new Client({ name: "e2e-mcp-client", version: "0.0.0" });
      trackCleanup(() => client.close());
      await client.connect(transport);

      const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
      const proxiedTools = withoutBuiltinTools(listed.tools);
      expect(proxiedTools).toHaveLength(1);
      expect(proxiedTools[0]!.name).toBe("echo");
      expect(proxiedTools[0]!.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } } });

      app.answerCalls((call) => ({ result: { echoed: (call.args as Record<string, unknown>).text } }));

      const called = await client.request(
        { method: "tools/call", params: { name: "echo", arguments: { text: "hello-mcp" } } },
        CallToolResultSchema,
      );
      expect(called.isError).not.toBe(true);
      expect(called.structuredContent).toEqual({ echoed: "hello-mcp" });

      // A second device connecting flips namespacing and fires list_changed.
      let listChangedCount = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        listChangedCount += 1;
      });

      const secondLink = await mintLink(stateDir);
      const secondApp = new FakeAppClient(port, pinnedKeys);
      const secondAck = await secondApp.claim(secondLink, { model: "iPhone 15" });
      secondApp.registerTools([{ name: "echo" }]);

      const deadline = Date.now() + 5000;
      while (listChangedCount === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(listChangedCount).toBeGreaterThan(0);

      const namespacedListing = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
      const namespacedNames = withoutBuiltinTools(namespacedListing.tools)
        .map((tool) => tool.name)
        .sort();
      expect(namespacedNames).toEqual([`${alias}__echo`, `${secondAck.alias}__echo`].sort());

      app.close();
      secondApp.close();
      await client.close();
    },
    20_000,
  );

  /*
   * Issue #29's second acceptance criterion, through the *real* argv path: `cordierite mcp
   * --scheme myapp` with an empty state dir. The in-process tests in
   * `mcp-command.integration.test.ts` call `handleMcpCommand({ scheme })` directly, which proves
   * the command honours the option but not that `create-cli.ts` declares it or that `dispatch.ts`
   * passes it through — the exact wiring an MCP config entry depends on.
   */
  test(
    "`cordierite mcp --scheme` reaches cordierite_connect with no scheme configured anywhere",
    async () => {
      const { stateDir } = await makeTempStateDir({ scheme: undefined });
      await ensureDaemon(stateDir);

      // Built explicitly rather than spread-and-override: an exported CORDIERITE_SCHEME on the
      // developer's machine would otherwise be able to satisfy this test without the flag working.
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        CORDIERITE_STATE_DIR: stateDir,
      };
      delete env.CORDIERITE_SCHEME;

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [binEntry, "mcp", "--scheme", "flag-scheme"],
        // `packageRoot` has no `app.json`, so discovery cannot supply the scheme either.
        cwd: packageRoot,
        env,
        stderr: "pipe",
      });

      const client = new Client({ name: "e2e-mcp-scheme-client", version: "0.0.0" });
      trackCleanup(() => client.close());
      await client.connect(transport);

      // `target: "none"` keeps this about scheme resolution rather than whatever simulators the
      // machine running the suite happens to have booted.
      const connected = await client.request(
        {
          method: "tools/call",
          params: { name: "cordierite_connect", arguments: { target: "none" } },
        },
        CallToolResultSchema,
      );

      expect(connected.isError).not.toBe(true);
      expect((connected.structuredContent as { deepLink: string }).deepLink).toMatch(
        /^flag-scheme:\/\/\/\?cordierite=/u,
      );

      await client.close();
    },
    20_000,
  );
});
