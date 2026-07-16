/** Opaque timer handle: never inspected, only round-tripped to `clearTimeout`. */
export type ClientTimerHandle = ReturnType<typeof setTimeout>;

/**
 * DI seam for the reconnect/backoff/grace state machine: real time in production, fully
 * controllable in tests (fake `setTimeout`/`now`, deterministic `random` for jitter assertions).
 */
export type ClientTimers = {
  setTimeout(callback: () => void, ms: number): ClientTimerHandle;
  clearTimeout(handle: ClientTimerHandle): void;
  /** Unix milliseconds. */
  now(): number;
  /** Jitter source for `computeFullJitterBackoffMs`; defaults to `Math.random`. */
  random(): number;
};

export const systemClientTimers: ClientTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
  now: () => Date.now(),
  random: () => Math.random(),
};
