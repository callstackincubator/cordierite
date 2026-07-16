import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CordieriteConnectionState } from "../Cordierite.types";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

type UrlListener = (event: { url: string }) => void;

let getInitialURLImpl: () => Promise<string | null> = () =>
  Promise.resolve(null);
let urlListeners: UrlListener[] = [];

// `deep-link-install.ts` imports `Linking` from "react-native" at module scope; "react-native"'s
// own source cannot be parsed under plain `bun test` (it is Flow-typed), so it must be mocked
// before the module under test is imported. See the module comment on `client/app-state.ts` for
// the same constraint on `AppState`.
void mock.module("react-native", () => ({
  Linking: {
    getInitialURL: () => getInitialURLImpl(),
    addEventListener: (_type: "url", listener: UrlListener) => {
      urlListeners.push(listener);
      return {
        remove() {
          urlListeners = urlListeners.filter((l) => l !== listener);
        },
      };
    },
  },
}));

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createMockClient = (initialState: CordieriteConnectionState = "idle") => {
  const state = initialState;
  const connects: unknown[] = [];
  return {
    connects,
    getState() {
      return state;
    },
    async connect(input: unknown) {
      connects.push(input);
    },
    reportBootstrapError() {},
  };
};

describe("installCordieriteDeepLinkBootstrap", () => {
  beforeEach(async () => {
    getInitialURLImpl = () => Promise.resolve(null);
    urlListeners = [];
    const mod = await import("../deep-link-install");
    mod.__cordieriteResetInstallGuardForTests();
  });

  afterEach(async () => {
    const mod = await import("../deep-link-install");
    mod.__cordieriteResetInstallGuardForTests();
  });

  test("a rejecting getInitialURL() is caught, not thrown (v1 defect: missing .catch)", async () => {
    getInitialURLImpl = () => Promise.reject(new Error("getInitialURL failed"));
    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient();

    expect(() => {
      installCordieriteDeepLinkBootstrap(client);
    }).not.toThrow();

    await flushMicrotasks();
    // No uncaught rejection reaches the test runner (bun would report it as an unhandled error
    // between tests, which is exactly the failure mode this covers).
    expect(client.connects).toEqual([]);
  });

  test("second call is a no-op when options match", async () => {
    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient();

    installCordieriteDeepLinkBootstrap(client, { requirePrivateIp: true });
    installCordieriteDeepLinkBootstrap(client, { requirePrivateIp: true });

    expect(urlListeners).toHaveLength(1);
  });

  test("options are threaded down to the deep-link handler (requirePrivateIp: false)", async () => {
    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient();

    installCordieriteDeepLinkBootstrap(client, { requirePrivateIp: false });
    expect(urlListeners).toHaveLength(1);

    const { encodeBootstrap } = await import("@cordierite/shared");
    const nonPrivatePayload = {
      family: 4 as const,
      address: "8.8.8.8",
      port: 8443,
      sessionId: "session-123",
      token: "a".repeat(43),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
    const url = `playground:///?cordierite=${encodeBootstrap(
      nonPrivatePayload
    )}`;

    urlListeners[0]?.({ url });
    await flushMicrotasks();

    expect(client.connects).toHaveLength(1);
  });

  test("reinstalling with different options logs a dev warning instead of silently keeping the first", async () => {
    const originalDevWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const { installCordieriteDeepLinkBootstrap } = await import(
        "../deep-link-install"
      );
      const client = createMockClient();

      installCordieriteDeepLinkBootstrap(client, { requirePrivateIp: true });
      installCordieriteDeepLinkBootstrap(client, { requirePrivateIp: false });

      // Still only one listener installed — the guard is run-once regardless.
      expect(urlListeners).toHaveLength(1);
      expect(
        warnings.some((args) =>
          args.some(
            (arg) =>
              typeof arg === "string" && arg.includes("different options")
          )
        )
      ).toBe(true);
    } finally {
      console.warn = originalDevWarn;
    }
  });
});
