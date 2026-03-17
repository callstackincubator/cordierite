import pc from "picocolors";
import type { SessionClaimDeviceInfo } from "cordierite-shared";

import type { HostDeviceStatusReporter } from "./runtime.js";
import { renderQrToTerminal } from "./qr-terminal.js";

const formatConnectedDeviceDetail = (device: SessionClaimDeviceInfo): string | undefined => {
  const parts = [device.manufacturer, device.model, device.os].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );

  return parts.length > 0 ? parts.join(" · ") : undefined;
};

export type CreateHostDeviceStatusReporterOptions = {
  write: (chunk: string) => void;
  color: boolean;
};

const formatTtlSeconds = (ttlSeconds: number): string => {
  return `${ttlSeconds}s`;
};

type ConnectionLineState =
  | { phase: "waiting" }
  | { phase: "connected"; device?: SessionClaimDeviceInfo }
  | { phase: "disconnected" };

const countMessageLines = (message: string): number => {
  return 1 + (message.match(/\n/g)?.length ?? 0);
};

/** Move to the first line of a multi-line status block, clear every line, leave cursor on line 1. */
const ansiClearStatusLines = (previousLineCount: number): string => {
  if (previousLineCount <= 1) {
    return "\r\x1b[K";
  }

  let s = `\x1b[${previousLineCount - 1}A`;
  s += "\r\x1b[K";
  for (let i = 1; i < previousLineCount; i++) {
    s += "\n\x1b[K";
  }
  s += `\x1b[${previousLineCount - 1}A`;
  return s;
};

export const createHostDeviceStatusReporter = (
  options: CreateHostDeviceStatusReporterOptions,
): HostDeviceStatusReporter => {
  const colors = pc.createColors(options.color);
  let dirty = false;
  let qrDone = false;
  let lineState: ConnectionLineState | null = null;
  let pendingTtlSeconds: number | null = null;
  let lastStatusLineCount = 0;

  const paint = (message: string) => {
    const prefix = ansiClearStatusLines(lastStatusLineCount);
    options.write(`${prefix}${message}`);
    lastStatusLineCount = countMessageLines(message);
    dirty = true;
  };

  const paintWaiting = () => {
    const ttlSuffix =
      pendingTtlSeconds === null ? "" : `\n${colors.dim("TTL:")} ${formatTtlSeconds(pendingTtlSeconds)}`;
    paint(`${colors.dim("Device:")} ${colors.yellow("waiting for connection")}${ttlSuffix}`);
  };

  const paintFromLineState = () => {
    if (!qrDone || lineState === null) {
      return;
    }

    if (lineState.phase === "waiting") {
      paintWaiting();
      return;
    }

    if (lineState.phase === "disconnected") {
      paint(`${colors.dim("Device:")} ${colors.yellow("disconnected")}`);
      return;
    }

    const detail = lineState.device ? formatConnectedDeviceDetail(lineState.device) : undefined;
    const tail = detail ? ` ${colors.dim("—")} ${colors.dim(detail)}` : "";
    paint(`${colors.dim("Device:")} ${colors.green("connected")}${tail}`);
  };

  return {
    async printBootstrapQr(deepLink: string, ttlSeconds: number) {
      if (qrDone) {
        return;
      }
      pendingTtlSeconds = ttlSeconds;
      try {
        const ascii = renderQrToTerminal(deepLink, { margin: 0, ecLevel: 1 });
        options.write(
          `\n${ascii}\n${colors.bold("Cordierite")}\n${colors.dim("Deep link:")} ${deepLink}\n`,
        );
      } catch {
        options.write(
          `\n${colors.dim("Could not render QR code for the deep link.")}\n${colors.dim("Deep link:")} ${deepLink}\n`,
        );
      }
      qrDone = true;
      paintFromLineState();
    },
    onListening() {
      lineState = { phase: "waiting" };
      paintFromLineState();
    },
    onClaimed(device) {
      if (lineState === null) {
        return;
      }
      pendingTtlSeconds = null;
      lineState = { phase: "connected", device };
      paintFromLineState();
    },
    onClaimedSessionEnded() {
      if (lineState === null) {
        return;
      }
      pendingTtlSeconds = null;
      lineState = { phase: "disconnected" };
      paintFromLineState();
    },
    dispose() {
      if (dirty) {
        options.write("\n");
        dirty = false;
      }
    },
  };
};
