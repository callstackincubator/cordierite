/**
 * Injectable timer seam (LOOP.md: "use injectable clock/timer seams for tests"). Every daemon
 * module that schedules a TTL/grace/pre-claim/keepalive timer takes a {@link TimerFns} so tests
 * can substitute an implementation that fires deterministically instead of waiting on real wall
 * time, and so every timer this package creates can be traced back to a single seam for cleanup.
 */

export type TimerHandle = ReturnType<typeof setTimeout>;
export type IntervalHandle = ReturnType<typeof setInterval>;

export type TimerFns = {
  setTimeout: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  setInterval: (callback: () => void, ms: number) => IntervalHandle;
  clearInterval: (handle: IntervalHandle) => void;
};

export const systemTimers: TimerFns = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};
