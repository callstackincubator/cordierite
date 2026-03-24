declare const __DEV__: boolean | undefined;

const PREFIX = "[Cordierite]";

const isDev = typeof __DEV__ !== "undefined" && __DEV__;

const prefixed = (args: unknown[]): unknown[] => [PREFIX, ...args];

/**
 * Internal and optional app logging. `debug` / `log` / `info` are dev-only; `warn` / `error` always
 * print so production issues remain visible.
 */
export const logger = {
  log(...args: unknown[]): void {
    if (isDev) {
      console.log(...prefixed(args));
    }
  },

  info(...args: unknown[]): void {
    if (isDev) {
      console.info(...prefixed(args));
    }
  },

  debug(...args: unknown[]): void {
    if (isDev) {
      console.debug(...prefixed(args));
    }
  },

  warn(...args: unknown[]): void {
    console.warn(...prefixed(args));
  },

  error(...args: unknown[]): void {
    console.error(...prefixed(args));
  },
};

export const maskSessionId = (sessionId: string): string =>
  sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 8)}…`;
