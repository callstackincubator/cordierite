/** Reconnect backoff bounds (ARCHITECTURE.md §11): 0.5 s floor, 30 s cap, full jitter. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;

/**
 * AWS-style "full jitter": `random(0, min(cap, base * 2^attempt))`. `attempt` is 0-based (the
 * first retry after a loss). Injectable `random` keeps the schedule deterministic in tests.
 */
export const computeFullJitterBackoffMs = (
  attempt: number,
  options: {
    baseMs?: number;
    capMs?: number;
    random?: () => number;
  } = {}
): number => {
  const baseMs = options.baseMs ?? BACKOFF_BASE_MS;
  const capMs = options.capMs ?? BACKOFF_CAP_MS;
  const random = options.random ?? Math.random;

  const upperBound = Math.min(capMs, baseMs * 2 ** Math.max(attempt, 0));

  return Math.floor(random() * upperBound);
};
