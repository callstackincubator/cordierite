/**
 * `cordierite mcp` (ARCHITECTURE.md §9, §10): starts a stdio MCP server that proxies the daemon RPC
 * (auto-spawn applies, same as every other command). This is a hosted command like `daemon run`/
 * `events` — it runs until the transport closes (client disconnected) or the process is
 * interrupted — and its stdout is reserved entirely for MCP protocol frames, so unlike every other
 * command it must never let `executeHostedCommand`'s default bootstrap render reach stdout (the
 * dispatcher wires an `"interactive"` reporter for exactly this reason, same as `events`).
 */

import type { Readable, Writable } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { CliResult } from "../cli/result-types.js";
import { loadConfig } from "../daemon/config.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import type { ExecFn } from "../cli/open-target.js";
import { createMcpServer, type McpServerHandle } from "../mcp/server.js";
import type { SpawnFn } from "../rpc/client.js";

export type McpCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
  /** Overrides `config.json`'s `scheme` (there is no per-invocation flag for `mcp`, unlike `link`). */
  scheme?: string;
  /** Overrides `config.json`'s `iosBundleId`; test seam, same shape as `scheme`. */
  iosBundleId?: string;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  /** Test seam: defaults to the real process stdin/stdout. */
  stdin?: Readable;
  stdout?: Writable;
};

export type McpHostedResult = {
  result: CliResult<never>;
  completion: Promise<void>;
  stop: () => void;
  /** Exposed for tests that need to drive the server directly (in-process transports). */
  handle: McpServerHandle;
};

export const handleMcpCommand = async (context: McpCommandContext): Promise<McpHostedResult> => {
  const paths = getStateDirPaths(context.stateDir);
  const config = await loadConfig(paths);
  const scheme = context.scheme ?? config.scheme;

  const handle = await createMcpServer({
    stateDir: context.stateDir,
    spawn: context.spawn,
    scheme,
    iosBundleId: context.iosBundleId ?? config.iosBundleId,
    exec: context.exec,
    env: context.env,
  });

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  let stopped = false;
  const stop = (): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    void handle.close().finally(resolveCompletion);
  };

  // The client disconnecting (stdin closed) ends the transport, which must end the command
  // gracefully rather than hang forever waiting for a Ctrl-C that will never come.
  handle.server.onclose = stop;
  handle.server.onerror = (error: Error) => {
    console.error("cordierite mcp: transport error:", error);
  };

  try {
    await handle.connect(new StdioServerTransport(context.stdin, context.stdout));
  } catch (error) {
    await handle.close();
    throw error;
  }

  return {
    // Never rendered: the dispatcher suppresses the bootstrap render for this command (see the
    // doc comment above) so stdout carries only MCP protocol frames.
    result: { ok: true, data: undefined as never },
    completion,
    stop,
    handle,
  };
};
