/**
 * `cordierite mcp` (ARCHITECTURE.md §9, §10): starts a stdio MCP server that proxies the daemon RPC
 * (auto-spawn applies, same as every other command). This is a hosted command like `daemon run`/
 * `events` — it runs until the transport closes (client disconnected) or the process is
 * interrupted — and its stdout is reserved entirely for MCP protocol frames, so unlike every other
 * command it must never let `executeHostedCommand`'s default bootstrap render reach stdout (the
 * dispatcher wires an `"interactive"` reporter for exactly this reason, same as `events`).
 *
 * The deep-link scheme (`--scheme`, `CORDIERITE_SCHEME`, project/state config, `app.json` — see
 * `scheme.ts`) is resolved once here at startup, and *not* finding one is not an error: see
 * {@link resolveSchemeForServer}.
 */

import type { Readable, Writable } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { CliResult } from "../cli/result-types.js";
import { loadConfig } from "../daemon/config.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import type { ExecFn } from "../cli/open-target.js";
import { createMcpServer, type McpServerHandle } from "../mcp/server.js";
import type { SpawnFn, VersionCheckOptions } from "../rpc/client.js";
import { resolveScheme } from "../scheme.js";

export type McpCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
  /** Daemon/CLI version check for the startup stream (issue #30); omitted = no check. */
  checkVersion?: VersionCheckOptions;
  /** `--scheme`, the highest-precedence source in `scheme.ts`'s order. */
  scheme?: string;
  /** Where scheme discovery starts; defaults to `process.cwd()`. */
  cwd?: string;
  /** Overrides `config.json`'s `iosBundleId`; test seam, same shape as `scheme`. */
  iosBundleId?: string;
  exec?: ExecFn;
  /** Environment for `adb`/`simctl`, not for `CORDIERITE_SCHEME` (see `schemeEnv`). */
  env?: NodeJS.ProcessEnv;
  /** The environment `CORDIERITE_SCHEME` is read from; defaults to `process.env`. */
  schemeEnv?: NodeJS.ProcessEnv;
  /** Test seam: defaults to the real process stdin/stdout. */
  stdin?: Readable;
  stdout?: Writable;
  /** Where startup diagnostics go. Defaults to `process.stderr` — never stdout, which carries only
   * MCP protocol frames. */
  stderr?: Pick<NodeJS.WriteStream, "write">;
};

export type McpHostedResult = {
  result: CliResult<never>;
  completion: Promise<void>;
  stop: () => void;
  /** Exposed for tests that need to drive the server directly (in-process transports). */
  handle: McpServerHandle;
};

/**
 * Resolves the deep-link scheme for the server, *never* throwing.
 *
 * Unlike `cordierite link`, an unresolved (or unresolvable) scheme must not stop `cordierite mcp`
 * from starting: the server is still fully useful for proxying an app's tools to a session that was
 * paired some other way (a QR scan, `cordierite link` in another terminal), and an MCP client that
 * cannot start its server gets a much worse failure than one whose `cordierite_connect` call
 * returns a clear `invalid_request`. So a scheme problem here is downgraded to an extra entry in
 * the `tried` list, which `cordierite_connect` renders if and when it is actually called.
 *
 * It is *also* reported on stderr at startup, because an explicitly wrong `--scheme myapp://` or
 * `CORDIERITE_SCHEME` is a typo the operator wants to hear about immediately, not only if and when
 * some agent happens to call `cordierite_connect`. Stderr, never stdout: stdout carries MCP
 * protocol frames exclusively, and MCP clients surface a server's stderr in their logs.
 */
const resolveSchemeForServer = async (
  context: McpCommandContext,
  configScheme: string | undefined,
  paths: ReturnType<typeof getStateDirPaths>,
): Promise<{ scheme?: string; tried: string[] }> => {
  try {
    return await resolveScheme({
      flagScheme: context.scheme,
      env: context.schemeEnv,
      cwd: context.cwd,
      configScheme,
      stateConfigPath: paths.configPath,
      stateDirRoot: paths.root,
    });
  } catch (error) {
    const message = (error as Error).message;

    (context.stderr ?? process.stderr).write(
      `cordierite mcp: could not resolve a deep-link scheme: ${message}\n` +
        "The server is starting anyway; cordierite_connect will fail until this is fixed.\n",
    );

    return { tried: [`(scheme resolution failed: ${message})`] };
  }
};

export const handleMcpCommand = async (context: McpCommandContext): Promise<McpHostedResult> => {
  const paths = getStateDirPaths(context.stateDir);
  const config = await loadConfig(paths);
  const { scheme, tried } = await resolveSchemeForServer(context, config.scheme, paths);

  const handle = await createMcpServer({
    stateDir: context.stateDir,
    spawn: context.spawn,
    checkVersion: context.checkVersion,
    scheme,
    schemeTried: tried,
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
