import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CordieriteDisabledError } from "../Cordierite.types";
import type { CordierePublicApi } from "../public-api";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

// The root (`.`) entry pulls in `react-native` (for `AppState`/`Linking`), whose own source cannot
// be parsed under plain `bun test` (Flow-typed; see `deep-link-install.test.ts`); `./noop` never
// touches `react-native` at all, but this file imports both entries side by side, so the mock is
// needed regardless.
void mock.module("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove() {} }),
  },
  Linking: {
    getInitialURL: () => Promise.resolve(null),
    addEventListener: () => ({ remove() {} }),
  },
}));

describe("noop parity: type-level (see also public-api.ts's doc comment)", () => {
  test("both entries structurally satisfy CordierePublicApi", async () => {
    const realModule = await import("../index");
    const noopModule = await import("../noop");

    // The meaningful check here is `tsc` (`bun run build`) accepting these two assignments — bun
    // strips types at runtime, so this is a signpost for the reader, not the enforcement, mirroring
    // `connect-options-parity.test.ts`'s pattern.
    const realSatisfiesPublicApi: CordierePublicApi = realModule;
    const noopSatisfiesPublicApi: CordierePublicApi = noopModule;

    const names: (keyof CordierePublicApi)[] = [
      "registerTool",
      "useCordieriteTool",
      "postEvent",
      "getRegisteredTools",
      "installCordieriteDeepLinkBootstrap",
      "addCordieriteListener",
      "getCordieriteState",
      "connect",
    ];
    for (const name of names) {
      expect(typeof realSatisfiesPublicApi[name]).toBe("function");
      expect(typeof noopSatisfiesPublicApi[name]).toBe("function");
    }
  });
});

describe("noop entry: runtime no-op behavior", () => {
  beforeEach(() => {
    void mock.module("react-native", () => ({
      AppState: {
        currentState: "active",
        addEventListener: () => ({ remove() {} }),
      },
      Linking: {
        getInitialURL: () => Promise.resolve(null),
        addEventListener: () => ({ remove() {} }),
      },
    }));
  });

  test("registerTool returns a disposer but registers nothing observable", async () => {
    const { registerTool } = await import("../noop");

    const registration = registerTool({
      name: "any-tool",
      description: "d",
      handler: () => "result",
    });

    expect(typeof registration.remove).toBe("function");
    expect(() => registration.remove()).not.toThrow();
  });

  test("postEvent resolves without doing anything", async () => {
    const { postEvent } = await import("../noop");
    await expect(postEvent("anything", { a: 1 })).resolves.toBeUndefined();
  });

  test("installCordieriteDeepLinkBootstrap is a no-op", async () => {
    const { installCordieriteDeepLinkBootstrap } = await import("../noop");
    expect(() => installCordieriteDeepLinkBootstrap()).not.toThrow();
  });

  test("addCordieriteListener returns a disposer; the callback never fires", async () => {
    const { addCordieriteListener } = await import("../noop");
    let fired = false;

    const subscription = addCordieriteListener("stateChange", () => {
      fired = true;
    });

    expect(fired).toBe(false);
    expect(() => subscription.remove()).not.toThrow();
  });

  test("getRegisteredTools() always returns an empty array, even after registerTool", async () => {
    const { registerTool, getRegisteredTools } = await import("../noop");

    registerTool({
      name: "any-tool",
      description: "d",
      handler: () => "result",
    });

    expect(getRegisteredTools()).toEqual([]);
  });

  test('getCordieriteState() always returns "idle"', async () => {
    const { getCordieriteState } = await import("../noop");
    expect(getCordieriteState()).toBe("idle");
  });

  test("connect() rejects with a CordieriteDisabledError (code: cordierite_disabled)", async () => {
    const { connect } = await import("../noop");

    await expect(
      connect({
        ip: "127.0.0.1",
        port: 8443,
        sessionId: "s",
        token: "a".repeat(43),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      })
    ).rejects.toThrow(CordieriteDisabledError);

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
      expect((error as CordieriteDisabledError).code).toBe(
        "cordierite_disabled"
      );
    }
  });
});
