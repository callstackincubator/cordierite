import type { CommandMeta } from "cordierite-shared";

import type { HostEventSink } from "./host-events.js";

export type Clock = {
  now: () => Date;
};

export type CommandContext = {
  clock: Clock;
};

export type HostCommandContext = CommandContext & {
  hostEvents?: HostEventSink;
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
