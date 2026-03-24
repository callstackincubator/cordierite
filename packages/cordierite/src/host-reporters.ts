import pc from "picocolors";

import type { HostLifecycleEvent } from "./host-events.js";
import { renderQrToTerminal } from "./qr-terminal.js";

type ReporterWriter = {
  write: (chunk: string) => void;
};

export type HostReporter = {
  kind: "interactive" | "plain";
  onEvent: (event: HostLifecycleEvent) => void | Promise<void>;
  dispose: () => void;
};

export type CreateHostReporterOptions = {
  writer: ReporterWriter;
  color: boolean;
};

const formatTtlSeconds = (ttlSeconds: number): string => {
  return `${ttlSeconds}s`;
};

const formatConnectedDeviceDetail = (
  device: HostLifecycleEvent & { type: "session_claimed" },
): string | undefined => {
  const parts = [device.device?.manufacturer, device.device?.model, device.device?.os].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );

  return parts.length > 0 ? parts.join(" · ") : undefined;
};

const countMessageLines = (message: string): number => {
  return 1 + (message.match(/\n/g)?.length ?? 0);
};

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

type ConnectionLineState =
  | { phase: "idle" }
  | { phase: "waiting"; ttlSeconds?: number }
  | { phase: "connected"; detail?: string }
  | { phase: "disconnected" };

export const createInteractiveHostReporter = (
  options: CreateHostReporterOptions,
): HostReporter => {
  const colors = pc.createColors(options.color);
  let dirty = false;
  let qrDone = false;
  let lineState: ConnectionLineState = { phase: "idle" };
  let lastStatusLineCount = 0;
  let pendingTtlSeconds: number | undefined;

  const paint = (message: string) => {
    const prefix = ansiClearStatusLines(lastStatusLineCount);
    options.writer.write(`${prefix}${message}`);
    lastStatusLineCount = countMessageLines(message);
    dirty = true;
  };

  const paintFromState = () => {
    if (!qrDone) {
      return;
    }

    if (lineState.phase === "idle") {
      return;
    }

    if (lineState.phase === "waiting") {
      const ttlSuffix =
        lineState.ttlSeconds === undefined
          ? ""
          : `\n${colors.dim("TTL:")} ${formatTtlSeconds(lineState.ttlSeconds)}`;
      paint(`${colors.dim("Device:")} ${colors.yellow("waiting for connection")}${ttlSuffix}`);
      return;
    }

    if (lineState.phase === "disconnected") {
      paint(`${colors.dim("Device:")} ${colors.yellow("disconnected")}`);
      return;
    }

    const tail = lineState.detail ? ` ${colors.dim("-")} ${colors.dim(lineState.detail)}` : "";
    paint(`${colors.dim("Device:")} ${colors.green("connected")}${tail}`);
  };

  return {
    kind: "interactive",
    onEvent(event) {
      if (event.type === "host_started") {
        pendingTtlSeconds = event.host.ttl_seconds;
        try {
          const ascii = renderQrToTerminal(event.host.deep_link, { margin: 0, ecLevel: 1 });
          options.writer.write(
            `\n${ascii}\n${colors.bold("Cordierite")}\n${colors.dim("Deep link:")} ${event.host.deep_link}\n`,
          );
        } catch {
          options.writer.write(
            `\n${colors.dim("Could not render QR code for the deep link.")}\n${colors.dim("Deep link:")} ${event.host.deep_link}\n`,
          );
        }
        qrDone = true;
        paintFromState();
        return;
      }

      if (event.type === "host_listening") {
        lineState = { phase: "waiting", ttlSeconds: pendingTtlSeconds };
        paintFromState();
        return;
      }

      if (event.type === "session_claimed") {
        pendingTtlSeconds = undefined;
        lineState = {
          phase: "connected",
          detail: formatConnectedDeviceDetail(event),
        };
        paintFromState();
        return;
      }

      if (event.type === "session_disconnected") {
        pendingTtlSeconds = undefined;
        lineState = { phase: "disconnected" };
        paintFromState();
        return;
      }

      if (event.type === "host_failed" || event.type === "host_stopped") {
        pendingTtlSeconds = undefined;
      }
    },
    dispose() {
      if (dirty) {
        options.writer.write("\n");
        dirty = false;
      }
    },
  };
};

export const createPlainTextHostReporter = (
  options: CreateHostReporterOptions,
): HostReporter => {
  const colors = pc.createColors(options.color);

  return {
    kind: "plain",
    onEvent(event) {
      switch (event.type) {
        case "host_started":
          options.writer.write(
            `${colors.dim("Deep link:")} ${event.host.deep_link}\n${colors.dim("TTL:")} ${formatTtlSeconds(event.host.ttl_seconds)}\n`,
          );
          return;
        case "host_listening":
          options.writer.write("Device: waiting for connection\n");
          return;
        case "session_claimed": {
          const detail = formatConnectedDeviceDetail(event);
          options.writer.write(
            detail ? `Device: connected (${detail})\n` : "Device: connected\n",
          );
          return;
        }
        case "session_disconnected":
          options.writer.write("Device: disconnected\n");
          return;
        case "host_failed":
        case "host_stopped":
          return;
      }
    },
    dispose() {},
  };
};
