/**
 * Task 16 scenario: MCP. An MCP client over stdio against a real `cordierite mcp` *subprocess*
 * (consolidating `mcp-server.integration.test.ts`'s in-process coverage at the subprocess level, as
 * the task calls for): list/call/list_changed with the fake app.
 */

import { afterEach, describe, expect, test } from "bun:test";

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

const BUILTIN_TOOL_NAMES = new Set(["cordierite_connect", "cordierite_wait_for_session"]);

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
        command: "bun",
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
});
