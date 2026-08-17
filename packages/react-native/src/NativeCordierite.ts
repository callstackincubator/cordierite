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

/**
 * Effective trust/pin configuration this build was compiled with, read via `getConstants()` from
 * the exact same manifest (Android)/plist (iOS) keys `resolveTrustedPins`
 * (`docs/tasks/05-explicit-trust-mode.md`) reads — never a second parse path, so this can never
 * disagree with what a real `connect()` call would use for the same native config.
 *
 * `trust` reports the *effective* bucket: `"pin"` whenever embedded pins are present (they always
 * win over the raw config value), `"link"` otherwise, or — only reachable via a hand-edited native
 * config the plugin itself refuses to produce — the raw unrecognized string a connect attempt
 * would reject with `invalidTrustValue`. Pin fingerprints are deliberately not exposed here; only
 * `hasEmbeddedPins` (their presence) is — see `docs/tasks/07-native-module-constants.md`.
 */
export type CordieriteBuildConfigNative = {
  trust: string;
  hasEmbeddedPins: boolean;
  allowPrivateLanOnly: boolean;
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
  /** See `CordieriteBuildConfigNative`'s doc comment. */
  getConstants(): CordieriteBuildConfigNative;

  readonly onStateChange: CodegenTypes.EventEmitter<CordieriteStateChangeEventNative>;
  readonly onMessage: CodegenTypes.EventEmitter<CordieriteMessageEventNative>;
  readonly onError: CodegenTypes.EventEmitter<CordieriteErrorEventNative>;
  readonly onClose: CodegenTypes.EventEmitter<CordieriteCloseEventNative>;
}

export const NativeCordierite =
  TurboModuleRegistry.getEnforcing<Spec>("Cordierite");
