import type { CliResult } from "./result-types.js";

import { getExitCodeForError, toCliError } from "../errors.js";
import { renderResult, type RenderOptions } from "../output.js";
import { createCommandMeta, type Clock, type CliIoWriters } from "./types.js";

/**
 * Long-lived command result shape shared by any CLI command that keeps a process alive
 * until completion/cancellation (e.g. a foreground daemon run). Not tied to any specific
 * command's data type.
 */
type HostedCommandResult = {
  result: CliResult<unknown>;
  completion: Promise<void>;
  stop: () => void;
};

/**
 * Minimal reporter contract for {@link executeHostedCommand}: an optional live-rendering
 * reporter that receives lifecycle events and must be disposed once the hosted command
 * completes. `kind: "plain"` reporters render their own bootstrap output instead of the
 * default `renderResult` output.
 */
export type HostedCommandReporter = {
  kind: "interactive" | "plain";
  onEvent: (event: unknown) => void | Promise<void>;
  dispose: () => void;
};

const writeRenderedOutput = (
  rendered: { stdout?: string; stderr?: string },
  writers: CliIoWriters,
): void => {
  if (rendered.stdout) {
    writers.stdout.write(rendered.stdout);
  }

  if (rendered.stderr) {
    writers.stderr.write(rendered.stderr);
  }
};

export const executeCommand = async (
  command: string,
  handler: () => CliResult<unknown> | Promise<CliResult<unknown>>,
  options: CliIoWriters &
    Pick<RenderOptions, "json" | "color"> &
    Partial<Pick<RenderOptions, "qr" | "full">> & {
      clock: Clock;
    },
): Promise<number> => {
  const startedAt = options.clock.now();
  const renderOptions: RenderOptions = {
    command,
    json: options.json,
    color: options.color,
    qr: options.qr,
    full: options.full,
  };

  try {
    const result = await handler();
    const finishedAt = options.clock.now();
    const withMeta: CliResult<unknown> = {
      ...result,
      meta: createCommandMeta(command, startedAt, finishedAt),
    };

    writeRenderedOutput(renderResult(withMeta, renderOptions), options);

    return 0;
  } catch (error) {
    const finishedAt = options.clock.now();
    const cliError = toCliError(error);
    const result: CliResult<never> = {
      ok: false,
      error: cliError,
      meta: createCommandMeta(command, startedAt, finishedAt),
    };

    writeRenderedOutput(renderResult(result, renderOptions), options);

    return getExitCodeForError(error);
  }
};

export const executeHostedCommand = async (
  command: string,
  handler: () => Promise<HostedCommandResult>,
  options: CliIoWriters & {
    json: boolean;
    color: boolean;
    clock: Clock;
    reporter?: HostedCommandReporter;
  },
): Promise<number> => {
  const startedAt = options.clock.now();
  let renderedSuccess = false;

  try {
    const hosted = await handler();
    const finishedAt = options.clock.now();
    const withMeta: CliResult<unknown> = {
      ...hosted.result,
      meta: createCommandMeta(command, startedAt, finishedAt),
    };

    // A live reporter (e.g. `events`'s streaming NDJSON/human lines) renders its own output as it
    // goes; only the absence of a reporter (or an explicit "plain" one) falls back to the default
    // one-shot `renderResult` bootstrap rendering.
    const liveReporter = options.reporter;
    const shouldRenderBootstrap = !liveReporter || liveReporter.kind === "plain";

    if (shouldRenderBootstrap) {
      writeRenderedOutput(
        renderResult(withMeta, {
          command,
          json: options.json,
          color: options.color,
        }),
        options,
      );
      renderedSuccess = true;
    }

    let resolved = false;
    const stop = () => {
      if (resolved) {
        return;
      }

      resolved = true;
      hosted.stop();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      await hosted.completion;
    } finally {
      resolved = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      options.reporter?.dispose();
    }

    return 0;
  } catch (error) {
    options.reporter?.dispose();

    const finishedAt = options.clock.now();
    const cliError = toCliError(error);
    const result: CliResult<never> = {
      ok: false,
      error: cliError,
      meta: createCommandMeta(command, startedAt, finishedAt),
    };

    if (renderedSuccess && options.json) {
      // The single-JSON-object-on-stdout contract was already fulfilled by the bootstrap render
      // above; a failure that happens later (e.g. during a long-running `completion`) must still
      // be a JSON object, just on stderr instead — bare text here was v1's defect (leaked
      // unparseable output onto stderr in `--json` mode).
      options.stderr.write(`${JSON.stringify(result)}\n`);
      return getExitCodeForError(error);
    }

    writeRenderedOutput(
      renderResult(result, {
        command,
        json: options.json,
        color: options.color,
      }),
      options,
    );

    return getExitCodeForError(error);
  }
};
