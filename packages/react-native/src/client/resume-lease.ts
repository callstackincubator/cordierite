import {
  isValidPort,
  MAX_WIRE_ID_LENGTH,
  MAX_WIRE_STRING_LENGTH,
} from "@cordierite/shared";

/** @internal Process-memory recovery data owned by the native implementation. */
export type ResumeLeaseV1 = {
  schemaVersion: 1;
  sessionId: string;
  resumeToken: string;
  alias: string;
  endpoint: { ip: string; port: number };
  keepaliveIntervalS: number;
  graceS: number;
  disconnectedAtMs: number | null;
};

/** @internal Synchronous seam matching the native process-memory lease API. */
export type ResumeLeaseStore = {
  get(): unknown;
  clear(): void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBoundedNonEmptyString = (
  value: unknown,
  maxLength: number
): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

const isPositiveFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export const parseResumeLease = (value: unknown): ResumeLeaseV1 | null => {
  if (!isRecord(value) || !isRecord(value.endpoint)) {
    return null;
  }

  const disconnectedAtMs = value.disconnectedAtMs;
  if (
    value.schemaVersion !== 1 ||
    !isBoundedNonEmptyString(value.sessionId, MAX_WIRE_ID_LENGTH) ||
    !isBoundedNonEmptyString(value.resumeToken, MAX_WIRE_ID_LENGTH) ||
    !isBoundedNonEmptyString(value.alias, MAX_WIRE_ID_LENGTH) ||
    !isBoundedNonEmptyString(value.endpoint.ip, MAX_WIRE_STRING_LENGTH) ||
    !isValidPort(value.endpoint.port) ||
    !isPositiveFiniteNumber(value.keepaliveIntervalS) ||
    !isPositiveFiniteNumber(value.graceS) ||
    !(
      disconnectedAtMs === null ||
      (typeof disconnectedAtMs === "number" &&
        Number.isFinite(disconnectedAtMs) &&
        disconnectedAtMs >= 0)
    )
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    sessionId: value.sessionId,
    resumeToken: value.resumeToken,
    alias: value.alias,
    endpoint: { ip: value.endpoint.ip, port: value.endpoint.port },
    keepaliveIntervalS: value.keepaliveIntervalS,
    graceS: value.graceS,
    disconnectedAtMs,
  };
};

export const isResumeLeaseExpired = (
  lease: ResumeLeaseV1,
  nowMs: number
): boolean =>
  lease.disconnectedAtMs !== null &&
  nowMs - lease.disconnectedAtMs >= lease.graceS * 1000;
