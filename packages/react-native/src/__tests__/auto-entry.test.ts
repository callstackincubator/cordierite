import { describe, expect, mock, test } from "bun:test";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

let urlListenerCount = 0;

// `../auto` pulls in the full root entry (`AppState`/`Linking` via `real-app-state.ts` and
// `deep-link-install.ts`); "react-native"'s own source cannot be parsed under plain `bun test`
// (Flow-typed; see `deep-link-install.test.ts`), so it is mocked here.
void mock.module("react-native", () => ({
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

describe("./auto entry", () => {
  test("importing it installs the deep-link bootstrap exactly once", async () => {
    // ESM module caching alone means a second `import` of the same specifier cannot re-run this
    // file's top-level `installCordieriteDeepLinkBootstrap()` call -- the real risk this guards
    // against is `installCordieriteDeepLinkBootstrap` itself being called more than once by that
    // one `import`, or by something the root entry does internally.
    await import("../auto");
    await import("../auto");

    expect(urlListenerCount).toBe(1);
  });

  test("re-exports the same top-level API as the root entry", async () => {
    const autoModule = await import("../auto");
    const rootModule = await import("../index");

    for (const name of [
      "registerTool",
      "useCordieriteTool",
      "postEvent",
      "installCordieriteDeepLinkBootstrap",
      "addCordieriteListener",
      "getCordieriteState",
      "connect",
    ] as const) {
      expect(typeof autoModule[name]).toBe("function");
      expect(autoModule[name]).toBe(rootModule[name]);
    }
  });
});
