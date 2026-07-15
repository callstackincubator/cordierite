export type UnixTimestampSeconds = number;

export const getCurrentUnixTimestampSeconds = (): UnixTimestampSeconds => {
  return Math.floor(Date.now() / 1000);
};

export const isExpiredAt = (
  expiresAt: UnixTimestampSeconds,
  now: UnixTimestampSeconds = getCurrentUnixTimestampSeconds(),
): boolean => {
  return expiresAt <= now;
};
