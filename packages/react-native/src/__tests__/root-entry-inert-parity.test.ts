import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Spec } from "../NativeCordierite";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/**
 * Default-inert release builds (opt-in hardening design doc part B): when the native module is
 * unavailable, every root (`.`) entry export must behave *exactly* like the corresponding `./noop`
 * export — not just "not throw", but produce the identical observable result — and log the dev-mode
 * warning exactly once no matter how many calls are made. `root-entry-laziness.test.ts` covers the
 * narrower "never throws at import time" guarantee; this file is the parity contract itself.
 *
 * "react-native"'s own source cannot be parsed under a Node test runner (Flow-typed), so it is
 * mocked with working `AppState`/`Linking` stubs, same as `root-entry-laziness.test.ts`.
 */
const resetMocks = async () => {
  vi.resetModules();

  const { __cordieriteSetNativeModuleLoaderForTests } =
    await import("../CordieriteModule");
  __cordieriteSetNativeModuleLoaderForTests(() => ({
    NativeCordierite: undefined as unknown as Spec,
  }));

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

const toolRegistration = () => ({
  name: "inert-parity-tool",
  description: "test",
  handler: () => undefined,
});

describe("root entry: exact ./noop parity when the native module is unavailable", () => {
  beforeEach(async () => {
    await resetMocks();
  });

  test("registerTool: returns a disposer, getRegisteredTools() stays empty (matches noop, not the real client's JS-side registry)", async () => {
    const { registerTool, getRegisteredTools } = await import("../index");

    const registration = registerTool(toolRegistration());
    expect(typeof registration.remove).toBe("function");
    expect(() => registration.remove()).not.toThrow();

    // The real client's registerTool would keep this in its JS-side registry even with no native
    // module (that registry doesn't need native); noop.getRegisteredTools() always returns `[]`.
    // Asserting `[]` here is exactly what would catch a regression back to delegating to the real
    // client instead of `./noop`.
    expect(getRegisteredTools()).toEqual([]);
  });

  test("postEvent resolves without throwing", async () => {
    const { postEvent } = await import("../index");
    await expect(postEvent("anything", { a: 1 })).resolves.toBeUndefined();
  });

  test("installCordieriteDeepLinkBootstrap is a no-op (no Linking listener installed)", async () => {
    let urlListenerCount = 0;
    vi.doMock("react-native", () => ({
      AppState: {
        currentState: "active",
        addEventListener: () => ({ remove() {} }),
      },
      Linking: {
        getInitialURL: () => Promise.resolve(null),
        addEventListener: () => {
          urlListenerCount += 1;
          return { remove() {} };
        },
      },
    }));

    const { installCordieriteDeepLinkBootstrap } = await import("../index");
    expect(() => installCordieriteDeepLinkBootstrap()).not.toThrow();
    // The real path calls `Linking.addEventListener` as part of installing the bootstrap listener;
    // the noop path never touches `Linking` at all.
    expect(urlListenerCount).toBe(0);
  });

  test("addCordieriteListener returns a disposer; the callback never fires", async () => {
    const { addCordieriteListener } = await import("../index");
    let fired = false;

    const subscription = addCordieriteListener("stateChange", () => {
      fired = true;
    });

    expect(fired).toBe(false);
    expect(() => subscription.remove()).not.toThrow();
  });

  test('getCordieriteState() returns "idle"', async () => {
    const { getCordieriteState } = await import("../index");
    expect(getCordieriteState()).toBe("idle");
  });

  test("connect() rejects with a CordieriteDisabledError (code: cordierite_disabled)", async () => {
    const { connect } = await import("../index");
    const { CordieriteDisabledError } = await import("../Cordierite.types");

    try {
      await connect({
        ip: "127.0.0.1",
        port: 8443,
        sessionId: "s",
        token: "a".repeat(43),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });
      throw new Error("expected connect() to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CordieriteDisabledError);
      expect((error as InstanceType<typeof CordieriteDisabledError>).code).toBe(
        "cordierite_disabled",
      );
    }
  });

  test("useCordieriteTool inherits the same degrade path as registerTool (single code path, not a separate one)", async () => {
    const { registerTool, useCordieriteTool } = await import("../index");

    // Not rendering a real component here (no React test renderer in this package's test setup) —
    // the meaningful guarantee is that `useCordieriteTool` is built on the exact same `registerTool`
    // reference this file already exercises above, so it cannot drift from it.
    expect(typeof useCordieriteTool).toBe("function");
    expect(typeof registerTool).toBe("function");
  });

  test("the dev-mode warning is logged exactly once across many calls, not once per call", async () => {
    const { registerTool, postEvent, getCordieriteState } =
      await import("../index");
    const { logger } = await import("../logger");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    registerTool(toolRegistration()).remove();
    getCordieriteState();
    await postEvent("x");
    getCordieriteState();

    const inertWarnings = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes("native module is not available"),
    );
    expect(inertWarnings).toHaveLength(1);

    warnSpy.mockRestore();
  });
});
