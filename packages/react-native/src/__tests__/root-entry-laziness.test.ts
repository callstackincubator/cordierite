import { beforeEach, describe, expect, vi, test } from "vitest";

import type { Spec } from "../NativeCordierite";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/**
 * The root entry must be side-effect-free and its TurboModule lookup lazy (ARCHITECTURE.md §11):
 * importing it, and calling `registerTool`, must never *throw*. Under default-inert release
 * builds, an unavailable native module is no longer treated as necessarily a broken
 * dev build: `connect()` (and every other exported function) now degrades to the exact `./noop`
 * entry's behavior instead of throwing an actionable "rebuild your dev client" error — a release
 * build with no `cliPins`/`enableInReleaseBuilds` opt-in is expected to have no native module at
 * all, so silently degrading (behind one warning log) is the correct default, not a defect to
 * surface loudly on every `connect()` call. See `noop-parity.test.ts` for the parity contract this
 * degrade path relies on.
 *
 * "react-native"'s own source cannot be parsed under a Node test runner (Flow-typed; see
 * `deep-link-install.test.ts` for the same constraint), so it is mocked with working `AppState`/
 * `Linking` stubs. The native-module loader resolves to a nullish `NativeCordierite` export --
 * the same "not found" case `CordieriteModule.ts`'s defensive check
 * treats identically to the real module throwing from `TurboModuleRegistry.getEnforcing` (Expo Go, a
 * misconfigured build, an inert release build, or this test's environment).
 */
let nativeAccessAttempts = 0;

const resetMocks = async () => {
  nativeAccessAttempts = 0;
  vi.resetModules();

  const { __cordieriteSetNativeModuleLoaderForTests } =
    await import("../CordieriteModule");
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

  test("getCordieriteState() never throws, even with no native module available", async () => {
    // Since opt-in hardening this *does* touch the native module once, via the
    // `isCordieriteNativeModuleAvailable` availability probe every exported function now runs —
    // unlike before, when only `connect` ever reached the native layer. The probe itself never
    // throws (`CordieriteModule.ts` catches internally), so the guarantee this test cares about
    // (no throw) still holds; only the "never touches" framing changed.
    const { getCordieriteState } = await import("../index");

    expect(getCordieriteState()).toBe("idle");
  });

  test("connect() degrades to the exact ./noop behavior when no native module is available", async () => {
    const { connect } = await import("../index");
    // Imported dynamically (not statically at the top of the file) so this is the *same* module
    // instance `connect`'s rejection actually throws from — `vi.resetModules()` in `resetMocks`
    // means a static top-level import would resolve to a stale, different `Cordierite.types`
    // instance, and `instanceof`/`toThrow(Class)` would spuriously fail across that boundary.
    const { CordieriteDisabledError } = await import("../Cordierite.types");

    await expect(connect(validConnectInput())).rejects.toThrow(
      CordieriteDisabledError,
    );
    expect(nativeAccessAttempts).toBeGreaterThan(0);
  });
});
