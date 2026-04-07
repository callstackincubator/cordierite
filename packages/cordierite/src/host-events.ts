import type { CliError, SessionClaimDeviceInfo } from "@cordierite/shared";

export type HostBootstrapEventData = {
  deep_link: string;
  ttl_seconds: number;
  spki_pin: string;
  session_id: string;
  wss_port: number;
  control_port: number;
};

export type HostLifecycleEvent =
  | {
      type: "host_started";
      host: HostBootstrapEventData;
    }
  | {
      type: "host_listening";
      session_id: string;
    }
  | {
      type: "session_claimed";
      session_id: string;
      device?: SessionClaimDeviceInfo;
    }
  | {
      type: "session_rejected";
      session_id: string;
      reason: string;
    }
  | {
      type: "session_disconnected";
      session_id: string;
    }
  | {
      type: "host_stopped";
      session_id: string;
    }
  | {
      type: "host_failed";
      session_id: string;
      error: CliError;
    };

export type HostEventSink = {
  emitHostEvent: (event: HostLifecycleEvent) => void;
};

export const noopHostEventSink: HostEventSink = {
  emitHostEvent() {},
};
