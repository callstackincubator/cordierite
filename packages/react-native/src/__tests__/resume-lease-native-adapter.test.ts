import { beforeEach, describe, expect, vi, test } from "vitest";

import type { Spec } from "../NativeCordierite";

const lease = {
  schemaVersion: 1,
  sessionId: "session-1",
  resumeToken: "resume-token-1",
  alias: "device-1",
  endpoint: { ip: "127.0.0.1", port: 8443 },
  keepaliveIntervalS: 15,
  graceS: 600,
  disconnectedAtMs: 1_234,
};

let nativeModuleReads = 0;
let getCalls = 0;
let clearCalls = 0;

let nativeModuleReadsAfterMockSetup = 0;

describe("native resume lease adapter", () => {
  beforeEach(async () => {
    nativeModuleReads = 0;
    getCalls = 0;
    clearCalls = 0;
    vi.resetModules();
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

    const { __cordieriteSetNativeModuleLoaderForTests } = await import("../CordieriteModule");
    __cordieriteSetNativeModuleLoaderForTests(() => ({
      get NativeCordierite() {
        nativeModuleReads += 1;
        return {
          connect: async () => {},
          send: async () => {},
          close: async () => {},
          getState: () => "idle",
          addListener: () => ({ remove() {} }),
          getResumeLease: () => {
            getCalls += 1;
            return lease;
          },
          clearResumeLease: () => {
            clearCalls += 1;
          },
        } as unknown as Spec;
      },
    }));
    nativeModuleReadsAfterMockSetup = nativeModuleReads;
  });
  test("module import does not resolve the TurboModule", async () => {
    await import("../CordieriteModule");
    expect(nativeModuleReads).toBe(nativeModuleReadsAfterMockSetup);
  });

  test("get synchronously returns the exact native lease", async () => {
    const { cordieriteNativeResumeLeaseStore } = await import(
      "../CordieriteModule"
    );

    const getCallsBeforeRead = getCalls;
    expect(cordieriteNativeResumeLeaseStore.get()).toEqual(lease);
    expect(getCalls).toBe(getCallsBeforeRead + 1);
    expect(nativeModuleReads).toBe(nativeModuleReadsAfterMockSetup + 1);
  });

  test("clear synchronously delegates to native", async () => {
    const { cordieriteNativeResumeLeaseStore } = await import(
      "../CordieriteModule"
    );

    const clearCallsBeforeClear = clearCalls;
    cordieriteNativeResumeLeaseStore.clear();
    expect(clearCalls).toBe(clearCallsBeforeClear + 1);
  });

  test("default client reads the adapter only when restoreSession is invoked", async () => {
    const getCallsBeforeImport = getCalls;
    const { cordieriteClient } = await import("../index");

    expect(getCalls).toBe(getCallsBeforeImport);
    await expect(cordieriteClient.restoreSession()).resolves.toBe(false);
    expect(getCalls).toBe(getCallsBeforeImport + 1);
  });
});
