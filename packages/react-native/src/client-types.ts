import type {
  CordieriteConnectionState,
  CordieriteConnectOptions,
  CordieriteModuleEvents,
} from "./Cordierite.types";
import type { AppStateLike } from "./client/app-state";
import type { ResumeLeaseStore } from "./client/resume-lease";
import type { ClientTimers } from "./client/timers";

export type EventSubscription = {
  remove(): void;
};

export type CordieriteNativeModuleLike = {
  /** Starts native handshake; does not imply JS-visible `"active"` state yet. */
  connect(options: CordieriteConnectOptions): Promise<void>;
  send(message: string): Promise<void>;
  close(): Promise<void>;
  getState(): CordieriteConnectionState;
  addListener<Event extends keyof CordieriteModuleEvents>(
    eventName: Event,
    listener: CordieriteModuleEvents[Event]
  ): EventSubscription;
};

export type CreateCordieriteClientOptions = {
  /**
   * When set, merged into native `connect` options and override native defaults for
   * `session_claim` device metadata (`deviceManufacturer`, `deviceModel`, `deviceOs`).
   */
  sessionClaimDeviceFields?: () =>
    | Pick<
        CordieriteConnectOptions,
        "deviceManufacturer" | "deviceModel" | "deviceOs"
      >
    | undefined;
  /** Default app-side handler timeout (ms) when a tool registration omits its own `timeoutMs`. */
  defaultToolTimeoutMs?: number;
  /** Test seam for the reconnect/backoff/grace timers and jitter source. Defaults to real timers. */
  timers?: ClientTimers;
  /** Test seam for AppState background/foreground gating. Defaults to react-native's `AppState`. */
  appState?: AppStateLike;
  /** @internal Synchronous process-memory recovery seam. No production default is wired yet. */
  resumeLeaseStore?: ResumeLeaseStore;
};
