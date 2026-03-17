import type { Clock } from "../runtime.js";

export type RunCliOptions = {
  stdout?: Pick<typeof process.stdout, "write" | "isTTY">;
  stderr?: Pick<typeof process.stderr, "write">;
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
