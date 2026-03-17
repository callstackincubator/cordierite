import type { CommandMeta, SessionClaimDeviceInfo } from "cordierite-shared";

export type Clock = {
  now: () => Date;
};

export type CommandContext = {
  clock: Clock;
};

export type HostDeviceStatusReporter = {
  printBootstrapQr: (deepLink: string, ttlSeconds: number) => Promise<void>;
  onListening: () => void;
  onClaimed: (device?: SessionClaimDeviceInfo) => void;
  onClaimedSessionEnded: () => void;
  dispose: () => void;
};

export type HostCommandContext = CommandContext & {
  deviceStatus?: HostDeviceStatusReporter;
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
