import { encodeBootstrap } from "@cordierite/shared";
import { afterEach, beforeEach, describe, expect, vi, test } from "vitest";

import type { CordieriteConnectionState } from "../Cordierite.types";
import type { Spec } from "../NativeCordierite";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

type UrlListener = (event: { url: string }) => void;

let getInitialURLImpl: () => Promise<string | null> = () =>
  Promise.resolve(null);
let urlListeners: UrlListener[] = [];

// `deep-link-install.ts` imports `Linking` from "react-native" at module scope; "react-native"'s
// own source cannot be parsed under a Node test runner (it is Flow-typed), so it must be mocked
// before the module under test is imported. See the module comment on `client/app-state.ts` for
// the same constraint on `AppState`.
vi.mock("react-native", () => ({
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

const validBootstrapUrl = () =>
  `playground:///?cordierite=${encodeBootstrap({
    family: 4,
    address: "127.0.0.1",
    port: 8443,
    sessionId: "session-123",
    token: "a".repeat(43),
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  })}`;

const nonPrivateBootstrapUrl = () =>
  `playground:///?cordierite=${encodeBootstrap({
    family: 4,
    address: "8.8.8.8",
    port: 8443,
    sessionId: "session-123",
    token: "a".repeat(43),
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  })}`;

const createMockClient = (
  initialState: CordieriteConnectionState = "idle",
  restoreSessionImpl: () => Promise<boolean> = () => Promise.resolve(false),
  restoredSessionId = "restored-session",
) => {
  let state = initialState;
  let sessionId: string | null = null;
  const connects: unknown[] = [];
  const supersedes: (boolean | undefined)[] = [];
  let restoreCalls = 0;
  return {
    connects,
    supersedes,
    get restoreCalls() {
      return restoreCalls;
    },
    async restoreSession() {
      restoreCalls += 1;
      const restored = await restoreSessionImpl();
      // Mirror the real client: a successful restore installs the leased session, which is what
      // the initial URL then has to be judged against.
      if (restored) {
        state = "active";
        sessionId = restoredSessionId;
      }
      return restored;
    },
    getState() {
      return state;
    },
    getSessionId() {
      return sessionId;
    },
    async connect(input: unknown, options?: { supersede?: boolean }) {
      connects.push(input);
      supersedes.push(options?.supersede);
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
    // The native-module loader is process-global; restore the default so a test that installs a
    // fake `getConstants()` cannot leak its address policy into the next one.
    const { __cordieriteSetNativeModuleLoaderForTests } = await import(
      "../CordieriteModule"
    );
    __cordieriteSetNativeModuleLoaderForTests();
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
    // No uncaught rejection reaches the test runner between tests, which is exactly the failure
    // mode this covers.
    expect(client.connects).toEqual([]);
  });

  test("second call is a no-op", async () => {
    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient();

    installCordieriteDeepLinkBootstrap(client);
    installCordieriteDeepLinkBootstrap(client);

    expect(urlListeners).toHaveLength(1);
    expect(client.restoreCalls).toBe(1);
  });

  test("a restored lease does not suppress an initial link for a different session", async () => {
    // The app launched *because* someone delivered this link, so it outranks a session recovered
    // from process memory. Skipping the initial URL whenever recovery succeeded is what made a
    // reloaded app silently ignore the operator's freshly minted session.
    getInitialURLImpl = () => Promise.resolve(validBootstrapUrl());
    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient(
      "idle",
      () => Promise.resolve(true),
      "an-older-session",
    );

    installCordieriteDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.restoreCalls).toBe(1);
    expect(client.connects).toHaveLength(1);
    expect(client.supersedes).toEqual([true]);
  });

  test("a restored lease for the very session the initial link names is left alone", async () => {
    // Same session on both sides: the lease already holds it, and the link's token is spent.
    getInitialURLImpl = () => Promise.resolve(validBootstrapUrl());
    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient(
      "idle",
      () => Promise.resolve(true),
      "session-123",
    );

    installCordieriteDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.restoreCalls).toBe(1);
    expect(client.connects).toEqual([]);
  });

  test("a missing startup lease falls back to the valid initial deep link", async () => {
    getInitialURLImpl = () => Promise.resolve(validBootstrapUrl());
    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient("idle", () => Promise.resolve(false));

    installCordieriteDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.connects).toHaveLength(1);
  });

  test("an unexpected recovery rejection falls back to the valid initial deep link", async () => {
    getInitialURLImpl = () => Promise.resolve(validBootstrapUrl());
    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient("idle", () =>
      Promise.reject(new Error("restore failed"))
    );

    installCordieriteDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.connects).toHaveLength(1);
  });

  test("the initial URL waits until startup recovery resolves", async () => {
    getInitialURLImpl = () => Promise.resolve(validBootstrapUrl());
    let resolveRestore: ((restored: boolean) => void) | undefined;
    const restoreResult = new Promise<boolean>((resolve) => {
      resolveRestore = resolve;
    });
    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient("idle", () => restoreResult);

    installCordieriteDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(urlListeners).toHaveLength(1);
    expect(client.connects).toEqual([]);

    resolveRestore?.(false);
    await flushMicrotasks();

    expect(client.connects).toHaveLength(1);
  });

  test("a non-private address is accepted only when native reports allowPrivateLanOnly: false", async () => {
    const { __cordieriteSetNativeModuleLoaderForTests } = await import(
      "../CordieriteModule"
    );
    __cordieriteSetNativeModuleLoaderForTests(() => ({
      NativeCordierite: {
        getConstants: () => ({
          trust: "link",
          hasEmbeddedPins: false,
          allowPrivateLanOnly: false,
        }),
      } as unknown as Spec,
    }));

    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient();

    installCordieriteDeepLinkBootstrap(client);
    expect(urlListeners).toHaveLength(1);

    urlListeners[0]?.({ url: nonPrivateBootstrapUrl() });
    await flushMicrotasks();

    // The address policy is native build config (`CordieriteAllowPrivateLanOnly`), the same value
    // native `connect()` enforces -- never a JS-side copy an app could set independently.
    expect(client.connects).toHaveLength(1);
  });

  test("a non-private address is rejected when the native build config cannot be read", async () => {
    const { __cordieriteSetNativeModuleLoaderForTests } = await import(
      "../CordieriteModule"
    );
    __cordieriteSetNativeModuleLoaderForTests(() => ({
      NativeCordierite: undefined as unknown as Spec,
    }));

    const { installCordieriteDeepLinkBootstrap } = await import(
      "../deep-link-install"
    );
    const client = createMockClient();

    installCordieriteDeepLinkBootstrap(client);
    urlListeners[0]?.({ url: nonPrivateBootstrapUrl() });
    await flushMicrotasks();

    // Fail closed: an unreadable config must never widen the address policy.
    expect(client.connects).toEqual([]);

    // ...and the listener really is live — otherwise the assertion above would pass for the wrong
    // reason (nothing installed at all).
    urlListeners[0]?.({ url: validBootstrapUrl() });
    await flushMicrotasks();
    expect(client.connects).toHaveLength(1);
  });
});
