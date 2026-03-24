import type { CliResult } from "cordierite-shared";

import { handleHostCommand } from "../commands/host.js";
import { getExitCodeForError, toCliError } from "../errors.js";
import type { HostReporter } from "../host-reporters.js";
import { renderResult } from "../output.js";
import {
  createCommandMeta,
  type Clock,
} from "../runtime.js";
import type { CliIoWriters } from "./types.js";

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

type HostedCommandResult = Awaited<ReturnType<typeof handleHostCommand>>;

export const executeCommand = async (
  command: string,
  handler: () => CliResult<unknown> | Promise<CliResult<unknown>>,
  options: CliIoWriters & {
    json: boolean;
    color: boolean;
    clock: Clock;
  },
): Promise<number> => {
  const startedAt = options.clock.now();

  try {
    const result = await handler();
    const finishedAt = options.clock.now();
    const withMeta: CliResult<unknown> = {
      ...result,
      meta: createCommandMeta(command, startedAt, finishedAt),
    };

    writeRenderedOutput(
      renderResult(withMeta, {
        command,
        json: options.json,
        color: options.color,
      }),
      options,
    );

    return 0;
  } catch (error) {
    const finishedAt = options.clock.now();
    const cliError = toCliError(error);
    const result: CliResult<never> = {
      ok: false,
      error: cliError,
      meta: createCommandMeta(command, startedAt, finishedAt),
    };

    writeRenderedOutput(
      renderResult(result, {
        command,
        json: options.json,
        color: options.color,
      }),
      options,
    );

    return getExitCodeForError(cliError);
  }
};

export const executeHostedCommand = async (
  command: string,
  handler: () => Promise<HostedCommandResult>,
  options: CliIoWriters & {
    json: boolean;
    color: boolean;
    clock: Clock;
    reporter?: HostReporter;
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

    const liveReporter = command === "host" ? options.reporter : undefined;
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

    renderedSuccess = true;

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
      options.stderr.write(`${cliError.message}\n`);
      return getExitCodeForError(cliError);
    }

    writeRenderedOutput(
      renderResult(result, {
        command,
        json: options.json,
        color: options.color,
      }),
      options,
    );

    return getExitCodeForError(cliError);
  }
};
