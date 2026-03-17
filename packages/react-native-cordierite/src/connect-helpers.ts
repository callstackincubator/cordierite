import type { ConnectBootstrapPayload } from "cordierite-shared";

import type {
  CordieriteConnectInput,
  CordieriteConnectOptions,
} from "./Cordierite.types";
import type { CreateCordieriteClientOptions } from "./client-types";

export const nowUnixSeconds = (): number => Math.floor(Date.now() / 1000);

export const toConnectOptions = (
  input: CordieriteConnectInput,
  clientOptions: CreateCordieriteClientOptions
): CordieriteConnectOptions => {
  const base: CordieriteConnectOptions = {
    ip: input.ip,
    port: input.port,
    sessionId: input.sessionId,
    token: input.token,
    expiresAt: input.expiresAt,
  };

  const fromOverrides = clientOptions.sessionClaimDeviceFields?.();

  return fromOverrides ? { ...base, ...fromOverrides } : base;
};

export const toBootstrapPayload = (
  input: CordieriteConnectOptions
): ConnectBootstrapPayload => ({
  ip: input.ip,
  port: input.port,
  sessionId: input.sessionId,
  token: input.token,
  expiresAt: input.expiresAt,
});
