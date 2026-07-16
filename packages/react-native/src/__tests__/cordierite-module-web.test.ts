import { describe, expect, test } from "bun:test";

import {
  cordieriteNativeModule,
  cordieriteNativeResumeLeaseStore,
} from "../CordieriteModule.web";

describe("CordieriteModule.web stub", () => {
  test('getState() returns "idle" instead of throwing (v1 defect)', () => {
    // Regression test: getState() used to throw on web, which crashed any code path that calls it
    // unconditionally (e.g. the deep-link handler's "already connecting/active?" guard) before an
    // app has a chance to guard against calling Cordierite APIs on an unsupported platform.
    expect(cordieriteNativeModule.getState()).toBe("idle");
  });

  test("connect/send/close still throw: Cordierite is iOS/Android-only", async () => {
    await expect(
      cordieriteNativeModule.connect({
        ip: "127.0.0.1",
        port: 8443,
        sessionId: "s",
        token: "t",
        expiresAt: 0,
      })
    ).rejects.toThrow();
    await expect(cordieriteNativeModule.send("{}")).rejects.toThrow();
    await expect(cordieriteNativeModule.close()).rejects.toThrow();
  });

  test("addListener returns a no-op removable subscription", () => {
    const subscription = cordieriteNativeModule.addListener("close", () => {});
    expect(() => {
      subscription.remove();
    }).not.toThrow();
  });

  test("resume lease store is inert and nonthrowing", () => {
    expect(cordieriteNativeResumeLeaseStore.get()).toBeNull();
    expect(() => cordieriteNativeResumeLeaseStore.clear()).not.toThrow();
  });
});
