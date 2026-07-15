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
    expiresAt: input.expiresAt,
  };

  const fromOverrides = clientOptions.sessionClaimDeviceFields?.();

  return fromOverrides ? { ...base, ...fromOverrides } : base;
};

/**
 * Client-side sanity check before invoking native `connect` (distinct from the structural
 * `decodeBootstrap` validation already performed when a payload comes from a deep link).
 */
export const isConnectOptionsValid = (
  options: CordieriteConnectOptions,
  now: number = nowUnixSeconds()
): boolean => {
  return (
    typeof options.ip === "string" &&
    options.ip.length > 0 &&
    isValidPort(options.port) &&
    typeof options.sessionId === "string" &&
    options.sessionId.length > 0 &&
    typeof options.token === "string" &&
    options.token.length > 0 &&
    !isExpiredAt(options.expiresAt, now)
  );
};
