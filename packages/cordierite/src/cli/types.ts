import type { CommandMeta } from "./result-types.js";

export type Clock = {
  now: () => Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

export const createCommandMeta = (
  command: string,
  startedAt: Date,
  finishedAt: Date,
): CommandMeta => {
  return {
    command,
    timestamp: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
  };
};

export type RunCliOptions = {
  stdout?: Pick<typeof process.stdout, "write" | "isTTY">;
  stderr?: Pick<typeof process.stderr, "write">;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  promptOutput?: NodeJS.WritableStream;
  clock?: Clock;
};

export type CliIoWriters = Required<Pick<RunCliOptions, "stdout" | "stderr">>;

export type CliRenderContext = {
  json: boolean;
  color: boolean;
  stdout: CliIoWriters["stdout"];
  stderr: CliIoWriters["stderr"];
  clock: Clock;
};
