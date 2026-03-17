import type {
  CordieriteConnectionState,
  CordieriteConnectOptions,
  CordieriteModuleEvents,
} from "./Cordierite.types";

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
};
