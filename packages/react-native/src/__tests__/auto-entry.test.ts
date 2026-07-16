import { describe, expect, test, vi } from "vitest";

describe("./auto entry in a fresh runtime", () => {
  test("keeps root inert, restores the native lease once, and re-exports the root API", async () => {
    vi.resetModules();

    let resumeLeaseReads = 0;
    let initialUrlReads = 0;
    let urlListenerCount = 0;
    const nativeConnectCalls: unknown[] = [];
    const subscription = () => ({ remove() {} });

    const nativeModule = {
        async connect(options: unknown) {
          nativeConnectCalls.push(options);
        },
        async send() {},
        async close() {},
        getState: () => "idle",
        getResumeLease: () => {
          resumeLeaseReads += 1;
          return {
            schemaVersion: 1,
            sessionId: "session-from-native-lease",
            resumeToken: "resume-token-from-native-lease",
            alias: "pixel-8",
            endpoint: { ip: "127.0.0.1", port: 8443 },
            keepaliveIntervalS: 15,
            graceS: 600,
            disconnectedAtMs: Date.now(),
          };
        },
        clearResumeLease() {},
        onStateChange: subscription,
        onMessage: subscription,
        onError: subscription,
        onClose: subscription,
    };

    vi.doMock("react-native", () => ({
      AppState: {
        currentState: "active",
        addEventListener: subscription,
      },
      Linking: {
        getInitialURL: () => {
          initialUrlReads += 1;
          return Promise.resolve(null);
        },
        addEventListener: () => {
          urlListenerCount += 1;
          return subscription();
        },
      },
    }));

    const { __cordieriteSetNativeModuleLoaderForTests } = await import("../CordieriteModule");
    __cordieriteSetNativeModuleLoaderForTests(() => ({ NativeCordierite: nativeModule }));
    const rootModule = await import("../index");
    expect(resumeLeaseReads).toBe(0);
    expect(initialUrlReads).toBe(0);
    expect(urlListenerCount).toBe(0);
    expect(nativeConnectCalls).toEqual([]);

    const autoModule = await import("../auto");
    await import("../auto");
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resumeConnect = nativeConnectCalls[0] as
      | { ip?: string; port?: number; sessionId?: string; resumeToken?: string }
      | undefined;
    expect(resumeLeaseReads).toBe(1);
    expect(initialUrlReads).toBe(1);
    expect(urlListenerCount).toBe(1);
    expect(nativeConnectCalls).toHaveLength(1);
    expect(resumeConnect).toMatchObject({
      ip: "127.0.0.1",
      port: 8443,
      sessionId: "session-from-native-lease",
      resumeToken: "resume-token-from-native-lease",
    });
    expect(autoModule.registerTool).toBe(rootModule.registerTool);
  });
});
