/**
 * `cordierite invoke` (ARCHITECTURE.md §10): `tools.call` round trip. Failures propagate as-is
 * (`DaemonRpcError`, preserving `error.data.type` verbatim) — `errors.ts`'s `toCliError` is what
 * renders `error.type` as the app's wire error type end-to-end, not this module's job.
 */

import { RPC_METHODS, type ToolsCallResult } from "@cordierite/shared";

import type { CliResult, InvokeCommandData } from "../cli/result-types.js";
import { deriveCallTransportTimeoutMs } from "../daemon/calls.js";
import { DaemonRpcError, openDaemonStream, type SpawnFn } from "../rpc/client.js";

export type InvokeCommandOptions = {
  selector?: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
};

export type InvokeCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
};

export const handleInvokeCommand = async (
  options: InvokeCommandOptions,
  context: InvokeCommandContext,
  /** Aborted on SIGINT (issue #9): closes the RPC connection that issued `tools.call`, which the
   * daemon treats as a mid-flight cancel and forwards to the app as `tool_cancel`. */
  signal?: AbortSignal,
): Promise<CliResult<InvokeCommandData>> => {
  const stream = await openDaemonStream({ stateDir: context.stateDir, spawn: context.spawn });

  try {
    const callPromise = stream.call<ToolsCallResult>(
      RPC_METHODS.toolsCall,
      {
        selector: options.selector,
        name: options.tool,
        args: options.args,
        timeoutMs: options.timeoutMs,
      },
      // Without this the socket watchdog defaults to 10 s and `--timeout 60000` still dies at 10 s
      // with a generic transport error instead of the daemon's own `tool_timeout` (issue #25).
      deriveCallTransportTimeoutMs(options.timeoutMs),
    );

    if (!signal) {
      const result = await callPromise;
      return { ok: true, data: result.result };
    }

    const result = await new Promise<ToolsCallResult>((resolve, reject) => {
      // Attached unconditionally, before the aborted check below — otherwise an already-aborted
      // signal cancels without ever wiring a handler onto `callPromise`, and the rejection that
      // follows from closing the stream below becomes an unhandled rejection.
      callPromise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));

      function cancel(): void {
        reject(new DaemonRpcError(-32000, `Tool "${options.tool}" was cancelled.`, { type: "tool_cancelled" }));
        // Dropping the connection is what actually cancels the call daemon-side (calls.ts's
        // per-connection onClose hook) — this promise settling doesn't wait for that to finish.
        stream.close();
      }

      if (signal.aborted) {
        cancel();
        return;
      }

      signal.addEventListener("abort", cancel, { once: true });
    });

    return { ok: true, data: result.result };
  } finally {
    stream.close();
  }
};
