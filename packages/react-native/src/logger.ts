declare const __DEV__: boolean | undefined;

const PREFIX = "[Cordierite]";

// Computed per call (not cached at module load): `__DEV__` is a bundler-injected global that some
// test environments set only after this module has already been imported transitively, and a
// cached constant would silently miss that.
const isDev = (): boolean => typeof __DEV__ !== "undefined" && Boolean(__DEV__);

const prefixed = (args: unknown[]): unknown[] => [PREFIX, ...args];

/**
 * Internal and optional app logging. `debug` / `log` / `info` are dev-only; `warn` / `error` always
 * print so production issues remain visible.
 */
export const logger = {
  log(...args: unknown[]): void {
    if (isDev()) {
      console.log(...prefixed(args));
    }
  },

  info(...args: unknown[]): void {
    if (isDev()) {
      console.info(...prefixed(args));
    }
  },

  debug(...args: unknown[]): void {
    if (isDev()) {
      console.debug(...prefixed(args));
    }
  },

  warn(...args: unknown[]): void {
    console.warn(...prefixed(args));
  },

  error(...args: unknown[]): void {
    console.error(...prefixed(args));
  },

  /** Dev-only `console.warn`, for expected-but-noteworthy app misuse (duplicate tool names, late timeout results, `postEvent` while inactive). Never prints in production. */
  devWarn(...args: unknown[]): void {
    if (isDev()) {
      console.warn(...prefixed(args));
    }
  },
};

export const maskSessionId = (sessionId: string): string =>
  sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 8)}…`;
