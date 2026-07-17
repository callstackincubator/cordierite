import type { TurboModule } from "react-native";
import { TurboModuleRegistry, CodegenTypes } from "react-native";

/**
 * JSON/TurboModule wire shape for `connect`. Keep in sync with `CordieriteConnectOptions` in
 * `./Cordierite.types.ts` (Codegen reads this file only; it does not follow that import).
 */
export type CordieriteConnectOptionsNative = {
  ip: string;
  port: number;
  sessionId: string;
  /** Claim token. Required unless `resumeToken` is given (protocol v2 `session_resume`). */
  token?: string;
  /** When present, native sends `session_resume` as the first frame instead of `session_claim`. */
  resumeToken?: string;
  expiresAt: number;
  deviceManufacturer?: string;
  deviceModel?: string;
  deviceOs?: string;
  /** Opt-in hardening dev-mode: the bootstrap deep link's separate `pin` param. Native only
   * trusts it when built in debug mode with no build-time `cliPins` configured; embedded pins
   * always win and release builds without pins keep the existing hard error regardless. */
  linkPin?: string;
};

export type CordieriteStateChangeEventNative = {
  state: string;
};

export type CordieriteMessageEventNative = {
  rawMessage: string;
};

export type CordieriteErrorEventNative = {
  code: string;
  message: string;
  phase?: string;
  nativeCode?: string;
  closeReason?: string;
  isRetryable?: boolean;
  hint?: string;
};

export type CordieriteCloseEventNative = {
  code: number | null;
  reason: string | null;
};

export type CordieriteResumeEndpointNative = {
  ip: string;
  port: CodegenTypes.Int32;
};

/** Exact process-memory lease shape exposed synchronously by the native implementations. */
export type CordieriteResumeLeaseV1Native = {
  schemaVersion: CodegenTypes.Int32;
  sessionId: string;
  resumeToken: string;
  alias: string;
  endpoint: CordieriteResumeEndpointNative;
  keepaliveIntervalS: number;
  graceS: number;
  disconnectedAtMs: number | null;
};

export interface Spec extends TurboModule {
  /**
   * Starts the TLS + WebSocket connection and sends the first protocol v2 frame: `session_claim`
   * (using `token`) or, when `resumeToken` is given instead, `session_resume`. Resolves once TLS
   * has completed and that first frame has been sent — not when connection state is already
   * `"active"`. Wait for `stateChange` to `"active"` before calling `send`. Rejects on pin
   * mismatch, TLS/transport failure, or invalid params (neither `token` nor `resumeToken` given).
   */
  connect(options: CordieriteConnectOptionsNative): Promise<void>;
  send(message: string): Promise<void>;
  close(): Promise<void>;
  getState(): string;
  getResumeLease(): CordieriteResumeLeaseV1Native | null;
  clearResumeLease(): void;

  readonly onStateChange: CodegenTypes.EventEmitter<CordieriteStateChangeEventNative>;
  readonly onMessage: CodegenTypes.EventEmitter<CordieriteMessageEventNative>;
  readonly onError: CodegenTypes.EventEmitter<CordieriteErrorEventNative>;
  readonly onClose: CodegenTypes.EventEmitter<CordieriteCloseEventNative>;
}

export const NativeCordierite =
  TurboModuleRegistry.getEnforcing<Spec>("Cordierite");
