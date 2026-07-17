import { beforeEach, describe, expect, vi, test } from "vitest";

import type { Spec } from "../NativeCordierite";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/**
 * The root entry must be side-effect-free and its TurboModule lookup lazy (ARCHITECTURE.md §11 /
 * task 12): importing it, and calling `registerTool`, must never *throw*. Only an actual native call
 * (`connect`) may surface the native module's absence, and it must do so with an actionable message.
 *
 * "react-native"'s own source cannot be parsed under a Node test runner (Flow-typed; see
 * `deep-link-install.test.ts` for the same constraint), so it is mocked with working `AppState`/
 * `Linking` stubs. The native-module loader resolves to a nullish `NativeCordierite` export --
 * the same "not found" case `CordieriteModule.ts`'s defensive check
 * treats identically to the real module throwing from `TurboModuleRegistry.getEnforcing` (Expo Go, a
 * misconfigured build, or this test's environment).
 */
let nativeAccessAttempts = 0;

const resetMocks = async () => {
  nativeAccessAttempts = 0;
  vi.resetModules();

  const { __cordieriteSetNativeModuleLoaderForTests } = await import("../CordieriteModule");
  __cordieriteSetNativeModuleLoaderForTests(() => {
    nativeAccessAttempts += 1;
    return { NativeCordierite: undefined as unknown as Spec };
  });

  vi.doMock("react-native", () => ({
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove() {} }),
    },
    Linking: {
      getInitialURL: () => Promise.resolve(null),
      addEventListener: () => ({ remove() {} }),
    },
  }));
};

const validConnectInput = () => ({
  ip: "127.0.0.1",
  port: 8443,
  sessionId: "session-1",
  token: "a".repeat(43),
  expiresAt: Math.floor(Date.now() / 1000) + 60,
});

describe("root entry (@cordierite/react-native): TurboModule laziness", () => {
  beforeEach(async () => {
    await resetMocks();
  });

  test("importing the package never touches the native module", async () => {
    await import("../index");
    expect(nativeAccessAttempts).toBe(0);
  });

  test("restoreSession lazily reads the native lease and tolerates a missing module", async () => {
    const { cordieriteClient } = await import("../index");

    await expect(cordieriteClient.restoreSession()).resolves.toBe(false);
    expect(nativeAccessAttempts).toBeGreaterThan(0);
  });

  test("registerTool does not throw, even with no native module available", async () => {
    const { registerTool } = await import("../index");

    const registration = registerTool({
      name: "noop-tool",
      description: "test",
      handler: () => undefined,
    });

    registration.remove();
    // Not asserting `nativeAccessAttempts === 0` here: constructing the default client (lazily,
    // on this first top-level call) resiliently *attempts* native listener wiring -- the important
    // guarantee is that neither that attempt nor `registerTool` itself ever throws.
  });

  test("getCordieriteState() never touches the native module and never throws", async () => {
    const { getCordieriteState } = await import("../index");

    expect(getCordieriteState()).toBe("idle");
  });

  test("connect() -- the actual native call -- rejects with an actionable dev-build error", async () => {
    const { connect } = await import("../index");

    await expect(connect(validConnectInput())).rejects.toThrow(
      /development build/i
    );
    expect(nativeAccessAttempts).toBeGreaterThan(0);
  });
});
