import {
  getCurrentUnixTimestampSeconds,
  isExpiredAt,
  isValidPort,
} from "@cordierite/shared";

import type {
  CordieriteConnectInput,
  CordieriteConnectOptions,
} from "./Cordierite.types";
import type { CreateCordieriteClientOptions } from "./client-types";

export const nowUnixSeconds = (): number => getCurrentUnixTimestampSeconds();

const isBootstrapPayloadInput = (
  input: CordieriteConnectInput
): input is CordieriteConnectInput & { address: string } => {
  return "address" in input;
};

/** Builds the `session_claim` first-frame options from a decoded v2 bootstrap (or manual options). */
export const toConnectOptions = (
  input: CordieriteConnectInput,
  clientOptions: CreateCordieriteClientOptions
): CordieriteConnectOptions => {
  // Native `connect` still speaks a single-`ip` shape (see the NOTE on `CordieriteConnectOptions`);
  // a v2 `BootstrapPayload` carries `family`/`address` instead of `ip`, so map it here.
  const ip = isBootstrapPayloadInput(input) ? input.address : input.ip;

  const base: CordieriteConnectOptions = {
    ip,
    port: input.port,
    sessionId: input.sessionId,
    token: input.token,
    ...("resumeToken" in input && input.resumeToken
      ? { resumeToken: input.resumeToken }
      : {}),
    expiresAt: input.expiresAt,
  };

  const fromOverrides = clientOptions.sessionClaimDeviceFields?.();

  return fromOverrides ? { ...base, ...fromOverrides } : base;
};

/**
 * Builds the `session_resume` first-frame options for an auto-reconnect attempt. `expiresAt` is a
 * native-side sanity guard only (never sent on the wire — see `SessionResumeMessage`), so it is
 * synthesized here rather than reused from the original (short-lived) bootstrap.
 */
export const toResumeConnectOptions = (params: {
  ip: string;
  port: number;
  sessionId: string;
  resumeToken: string;
  now: number;
  graceSeconds: number;
}): CordieriteConnectOptions => {
  return {
    ip: params.ip,
    port: params.port,
    sessionId: params.sessionId,
    resumeToken: params.resumeToken,
    // Comfortably past the guard check on native, independent of the original claim's expiry.
    expiresAt: params.now + Math.max(params.graceSeconds, 60) + 60,
  };
};

/**
 * Client-side sanity check before invoking native `connect` (distinct from the structural
 * `decodeBootstrap` validation already performed when a payload comes from a deep link).
 */
export const isConnectOptionsValid = (
  options: CordieriteConnectOptions,
  now: number = nowUnixSeconds()
): boolean => {
  const hasClaimToken =
    typeof options.token === "string" && options.token.length > 0;
  const hasResumeToken =
    typeof options.resumeToken === "string" && options.resumeToken.length > 0;

  return (
    typeof options.ip === "string" &&
    options.ip.length > 0 &&
    isValidPort(options.port) &&
    typeof options.sessionId === "string" &&
    options.sessionId.length > 0 &&
    (hasClaimToken || hasResumeToken) &&
    !isExpiredAt(options.expiresAt, now)
  );
};
