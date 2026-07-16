import { mock } from "bun:test";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

let resumeLeaseReads = 0;
let initialUrlReads = 0;
let urlListenerCount = 0;
const nativeConnectCalls: unknown[] = [];

const subscription = () => ({ remove() {} });

await mock.module("../../NativeCordierite", () => ({
  NativeCordierite: {
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
  },
}));

await mock.module("react-native", () => ({
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

const rootModule = await import("../../index");

if (
  resumeLeaseReads !== 0 ||
  initialUrlReads !== 0 ||
  urlListenerCount !== 0 ||
  nativeConnectCalls.length !== 0
) {
  throw new Error("The root entry performed startup work.");
}

const autoModule = await import("../../auto");
await import("../../auto");
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 0));

const resumeConnect = nativeConnectCalls[0] as
  | {
      ip?: string;
      port?: number;
      sessionId?: string;
      resumeToken?: string;
    }
  | undefined;

if (
  resumeLeaseReads !== 1 ||
  initialUrlReads !== 1 ||
  urlListenerCount !== 1 ||
  nativeConnectCalls.length !== 1 ||
  resumeConnect?.ip !== "127.0.0.1" ||
  resumeConnect.port !== 8443 ||
  resumeConnect.sessionId !== "session-from-native-lease" ||
  resumeConnect.resumeToken !== "resume-token-from-native-lease"
) {
  throw new Error(
    "The auto entry did not restore the native lease exactly once."
  );
}

for (const name of [
  "registerTool",
  "useCordieriteTool",
  "postEvent",
  "installCordieriteDeepLinkBootstrap",
  "addCordieriteListener",
  "getCordieriteState",
  "connect",
] as const) {
  if (autoModule[name] !== rootModule[name]) {
    throw new Error(`The auto entry did not re-export ${name} from the root.`);
  }
}

console.log("auto recovery fixture passed");
process.exit(0);
