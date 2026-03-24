import type { AgentEndpoint } from "./transport.js";

export type SessionId = string;
export type SessionToken = string;
export type UnixTimestampSeconds = number;

export type SessionStatus = "pending" | "active";

export type PendingSessionRecord = AgentEndpoint & {
  session_id: SessionId;
  token: SessionToken;
  expires_at: UnixTimestampSeconds;
  status: SessionStatus;
};

export const getCurrentUnixTimestampSeconds = (): UnixTimestampSeconds => {
  return Math.floor(Date.now() / 1000);
};

export const isExpiredAt = (
  expiresAt: UnixTimestampSeconds,
  now: UnixTimestampSeconds = getCurrentUnixTimestampSeconds(),
): boolean => {
  return expiresAt <= now;
};

export const canClaimPendingSession = (
  session: PendingSessionRecord,
  now: UnixTimestampSeconds = getCurrentUnixTimestampSeconds(),
): boolean => {
  return session.status === "pending" && !isExpiredAt(session.expires_at, now);
};
