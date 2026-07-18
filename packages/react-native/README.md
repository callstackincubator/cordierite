[![Cordierite][cordierite-banner]][repo]

### Tools and state from outside the app—without debug menus

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

This package is the **native client** for Cordierite. Your app **registers tools** in JavaScript; **developers, testers, and agents** invoke them from a **CLI or host** after the app opens a bootstrap link and completes a **pinned `wss://`** handshake. You get **production-grade transport** (TLS + SPKI) instead of burying **debug-only screens** in the UI to flip state or trigger flows.

## Why use it

- **No in-app debug chrome**: influence screens, flags, fixtures, and flows from the **host**, not from hidden menus shipped to users.
- **Same path for people and automation**: CLI for devs/QA, agents for scripted or LLM-driven control—both use **tool calls** after session claim.
- **Production-capable**: ship the client in real builds when your pins and operational model say it is acceptable; connectivity still requires a **trusted host**, not public anonymous access.

## Security highlights

- **TLS required** for the Cordierite socket; pins are **SHA-256 over SPKI** (`sha256/...`) so only **your** host keys match.
- **Optional `allowPrivateLanOnly`**: when enabled, bootstrap must target a **local IPv4** address (RFC1918 private ranges or `127.0.0.1`)—a **dev-hardening** switch, not a claim that Cordierite is LAN-only.

## Getting started

> [!NOTE]
> Use a **development build** or bare native app. **Expo Go** is not enough—this library ships native code and pinning configuration.

### 1. Install the package

Install the app-side package and a schema library for tool definitions:

```bash
npm install @cordierite/react-native zod
```

Install the CLI separately on the machine that will run the host:

```bash
npm install cordierite
```

### 2. On a debug build, that's it for keys and pins

**Debug builds need no key, no pins, and no config plugin at all.** The daemon auto-generates its own `key.pem` the first time it starts (printing its `sha256/...` fingerprint), and `cordierite link` composes that fingerprint into the deep link as a separate `pin` query param. On a debug build (`#if DEBUG` on iOS, `FLAG_DEBUGGABLE` on Android) with no build-time `cliPins`/`CLI_PINS` configured, the native client trusts that link-carried pin for the session it arrived with, logging unconditionally: `Cordierite: trusting pin from bootstrap link (dev mode). Release builds require embedded cliPins.` The moment `cliPins` is configured, that embedded set always wins and the link's `pin` is ignored — see [`docs/SECURITY.md`](../../docs/SECURITY.md)'s "Dev trust mode" section for the full writeup.

Skip straight to step 3 (scheme) and step 4 (import) if that's all you need. The rest of this section is for **production and internal-distribution release builds**, which are inert by default (see "Hardening for production / internal builds" below) and need real embedded pins.

### 3. Configure native pinning, release opt-in, and app scheme

#### Expo

Add the **`@cordierite/react-native`** config plugin to Expo config. `cliPins` is optional for a debug-only app (omit it and the dev-mode flow above applies), but required — non-empty, each a `sha256/` + 44-character base64 SPKI pin, or the plugin throws naming the offending value — whenever `enableInReleaseBuilds: true` is set. Also optional: `allowPrivateLanOnly` (defaults to `true`, fail-closed) and `deepLinkScheme` (warns at prebuild time if it isn't declared in `expo.scheme`):

```json
{
  "expo": {
    "scheme": "myapp",
    "plugins": [
      [
        "@cordierite/react-native",
        {
          "cliPins": ["sha256/REPLACE_WITH_KEYGEN_OUTPUT"],
          "allowPrivateLanOnly": true,
          "deepLinkScheme": "myapp",
          "enableInReleaseBuilds": true
        }
      ]
    ]
  }
}
```

Generate the pin with `cordierite keygen`, which prints the exact `sha256/...` fingerprint value to use. Then run your normal prebuild / rebuild flow so native config receives those values.

Leave `enableInReleaseBuilds` unset (or `false`) if you never want Cordierite compiled into release builds at all — it's the default, and a plain debug-only setup can skip this whole plugin entry.

#### Bare React Native

Autolink the module and set the equivalent native keys. Field names and semantics mirror the Expo plugin (see [app.plugin.js](app.plugin.js)).

**Bare React Native — native keys**

iOS `Info.plist`:

| Key | Purpose |
| --- | ------- |
| `CordieriteCliPins` | String array of `sha256/...` SPKI pins |
| `CordieriteAllowPrivateLanOnly` | Boolean; if true, bootstrap host must be a local IPv4 address |

Android `<application>` meta-data:

| Name | Purpose |
| --- | ------- |
| `com.callstackincubator.cordierite.CLI_PINS` | JSON array string of pin values |
| `com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY` | Boolean meta-data value (a `"true"`/`"false"` String is also accepted); defaults to `true` (fail-closed) when absent |

Neither of the above is required for a debug-only app — see step 2. Wire **deep links** so the OS can open your app with the host's bootstrap URL, and make sure the app scheme matches the one `cordierite link` (or the `deepLinkScheme` plugin option, or `config.json`) uses to compose that link.

### 4. Import Cordierite in the JS entry point

The package has three entries:

| Entry | Behavior |
| --- | --- |
| `@cordierite/react-native` | Side-effect-free. Exports `registerTool`, `useCordieriteTool`, `postEvent`, `installCordieriteDeepLinkBootstrap`, `addCordieriteListener`, `getCordieriteState`, `connect`, and types. The native module is looked up **lazily**, on the first actual native call — importing it (even in Expo Go or a misconfigured build) never crashes; only calling a native-requiring function like `connect()` without native support does, with an actionable error. |
| `@cordierite/react-native/auto` | Same exports, plus a side effect: installs the default deep-link bootstrap listener and starts recovery from the native process lease on import (the old v1 root-import behavior, now opt-in). |
| `@cordierite/react-native/noop` | Same public API, fully inert — for compiling Cordierite out of release builds (see below). |

Most apps just want the deep-link listener installed automatically, so import the side-effect entry once near your app's entry point:

```ts
import "@cordierite/react-native/auto";
```

If you'd rather drive bootstrap yourself (custom deep-link handling, QR scanning, tests), import from the root entry and call `installCordieriteDeepLinkBootstrap()` (or `connect()` directly) when you're ready:

```ts
import { installCordieriteDeepLinkBootstrap } from "@cordierite/react-native";

installCordieriteDeepLinkBootstrap();
```

**Bootstrap connection and recovery:** installation registers the runtime URL listener immediately, reads the initial launch URL, and attempts native-lease recovery once. The initial URL waits for recovery: a successful restore suppresses the old launch-link claim, while no lease or an unexpected orchestration failure falls back to the normal initial-link flow. Runtime URLs still parse the v2 bootstrap payload and call `connect` when the client is idle. You do not need your own `Linking` handler for the default flow.

The resume lease is native **process-memory only** and is committed before JS receives each successful claim/resume acknowledgement. That supports Metro reloads and JS runtime replacement with the same alias and no new link, provided the native app process stays alive. It is never persisted to disk; after native process death, open a fresh bootstrap link. The grace window starts when the transport suspends/disconnects, not when the acknowledgement was received. Advanced flows can trigger the same recovery explicitly with `cordieriteClient.restoreSession()`.

**Errors:** use `addCordieriteListener("error", callback)` for bootstrap-parse, connect, socket, and tool-handler failures — one unified channel.

### 5. Define tools in app startup code

Call `registerTool({ ... })` with Standard Schema compatible `inputSchema` and `outputSchema` values plus a `handler` so the host can invoke your tools after the session is active. `zod` v4 works well here (its built-in JSON Schema exporter means agents see a real tool shape — zod 3 and plain valibot schemas still register, just with a dev warning and an empty schema).

`useCordieriteTool` wraps `registerTool` in a `useEffect` so registration follows the component's lifecycle, including remounts and Fast Refresh:

```ts
import "@cordierite/react-native/auto";
import { useCordieriteTool } from "@cordierite/react-native";
import { z } from "zod";

export function CordieriteBootstrap() {
  useCordieriteTool(
    {
      name: "sum",
      description: "Add two numeric values",
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      outputSchema: z.object({
        total: z.number(),
      }),
      handler: async ({ a, b }) => ({
        total: a + b,
      }),
    },
    []
  );

  return null;
}
```

Mount that component near app startup, or register from another module that loads on startup. The host can only list and invoke tools that your app has already registered.

### 6. Start the daemon and test the flow

`cordierite` auto-spawns its daemon on first use, so most CLI commands just work:

```bash
cordierite link --qr
```

Scan the printed QR (or open the deep link) in the app, then inspect and invoke tools:

```bash
cordierite tools
cordierite invoke sum --input '{"a":2,"b":3}'
```

Omit the session selector when you only have one active session — `cordierite` uses it automatically; pass an alias or session id when you have several (`cordierite ls` lists them).

## Hardening for production / internal builds

Cordierite ships **inert by default** in release builds:

- **Android**: `CordieritePackage.getModule` returns `null` unless the app is debuggable (`ApplicationInfo.FLAG_DEBUGGABLE`) or the app opted in via the `com.callstackincubator.cordierite.ENABLE_IN_RELEASE` manifest meta-data (Boolean; the config plugin writes it from `enableInReleaseBuilds`).
- **iOS**: `CordieriteTurboBridge.swift` and `RCTNativeCordierite.mm` are both compiled out entirely unless `#if DEBUG || CORDIERITE_ENABLE_RELEASE` — a Swift compilation condition (`SWIFT_ACTIVE_COMPILATION_CONDITIONS`) and a preprocessor macro (`GCC_PREPROCESSOR_DEFINITIONS`, `CORDIERITE_ENABLE_RELEASE=1`) that the config plugin adds to the Cordierite pod's own Release build configuration via a `post_install` hook when `enableInReleaseBuilds: true` is set.
- **JS**: with the native module absent (debug-tooling-free JS bundle, Expo Go) or inert (a release build that didn't opt in above), every exported function on the root `@cordierite/react-native` entry degrades to the exact `./noop` entry's behavior — one warning log the first time, no throws, `getCordieriteState()` reporting `"idle"`, `connect()` always rejecting with `CordieriteDisabledError` (`code: "cordierite_disabled"`).

Opting in requires `enableInReleaseBuilds: true` **and** non-empty `cliPins` (bare RN: the `ENABLE_IN_RELEASE`/`CORDIERITE_ENABLE_RELEASE` flags **and** `CordieriteCliPins`/`CLI_PINS`) — a release build with the module enabled but no pins would have no way to trust anything, so the plugin refuses that combination at config time.

**iOS custom build configurations:** Xcode configurations other than the stock Debug/Release pair (e.g. a "Staging" scheme) do not get the `DEBUG` compilation condition either, so Cordierite stays off there by default too — opt in with `CORDIERITE_ENABLE_RELEASE` the same way you would for Release.

**Resulting behavior matrix:**

| Build   | Default                                                    | Opt-in                                          |
| ------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Debug   | Fully active, zero config (link-carried pin trusted)        | `cliPins` for pinned trust instead               |
| Release | Inert — module unregistered (Android) / compiled out (iOS)  | `enableInReleaseBuilds` + `cliPins` → hardened   |

## Compiling Cordierite out of production builds

Even with default-inert release builds (above), the package's JS and native code still ships **inside the bundle/binary** unless you go one step further and strip it at build time. Neither half below removes native code by itself — importing `/noop` only swaps out the *JS* module; it does not touch what CocoaPods/Gradle compiled into the app binary. The correct recipe is the pair:

**1. Native — exclude the dependency from autolinking**, so zero native Cordierite code is compiled in. In a `react-native.config.js` at your app root:

```js
module.exports = {
  dependencies: {
    "@cordierite/react-native": {
      platforms: {
        ios: null,
        android: null,
      },
    },
  },
};
```

The Expo-managed equivalent is `expo.autolinking`'s per-platform `exclude` list in `app.json` / `app.config.*`:

```json
{
  "expo": {
    "autolinking": {
      "ios": { "exclude": ["@cordierite/react-native"] },
      "android": { "exclude": ["@cordierite/react-native"] }
    }
  }
}
```

**2. JS — swap the module at bundle time**, so no Cordierite JS (deep-link listener, tool registry, client state machine) ends up in the bundle either. Add a Metro `resolveRequest` override in `metro.config.js`:

```js
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const isProductionBuild = process.env.CORDIERITE_ENABLED !== "1";

if (isProductionBuild) {
  const original = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === "@cordierite/react-native") {
      return context.resolveRequest(
        context,
        "@cordierite/react-native/noop",
        platform
      );
    }
    if (moduleName === "@cordierite/react-native/auto") {
      // `/noop` has no side effect on import, matching `/auto`'s shape without installing anything.
      return context.resolveRequest(
        context,
        "@cordierite/react-native/noop",
        platform
      );
    }
    return original
      ? original(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = config;
```

If you'd rather not touch Metro config, a conditional `require` at each import site works too (module identity differs per call site, so this is more repetitive but avoids any bundler-level indirection):

```ts
const { registerTool, useCordieriteTool } = __DEV__
  ? require("@cordierite/react-native")
  : require("@cordierite/react-native/noop");
```

Either way, `/noop` is typed identically to the root entry (both implement the same shared interface — see `src/public-api.ts` and `src/__tests__/noop-parity.test.ts`), so switching between them is a drop-in swap: `registerTool` still returns a disposer, `connect()` still returns a `Promise<void>` (it just always rejects with a `CordieriteDisabledError`, `code: "cordierite_disabled"`), and `getCordieriteState()` always reports `"idle"`.

**Either half alone still yields a working, inert app.** The `/noop` Metro swap alone gives you an app with no Cordierite JS running but the native pod still compiled in (unused); the autolinking exclude alone gives you an app with no native Cordierite code but that still imports the real JS entry, which finds no native module and degrades to the same `/noop`-equivalent behavior described in "Hardening for production / internal builds" above. Combine both when you want neither surface present at all — for example, to satisfy an app-store reviewer who wants no "remote control" surface whatsoever, not just an inert one.

## Platform compatibility

| Platform | Support |
| --- | --- |
| **iOS** | 15.1+ (`Cordierite.podspec`), New Architecture |
| **Android** | Autolinked, New Architecture |
| **Web** | Stub only |


## Made with ❤️ at Callstack

`cordierite` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[cordierite-banner]: https://img.shields.io/badge/Cordierite-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/cordierite
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=cordierite&utm_term=readme-with-love
[license-badge]: https://img.shields.io/npm/l/cordierite?style=for-the-badge
[license]: https://github.com/callstackincubator/cordierite/blob/main/LICENSE
[npm-downloads-badge]: https://img.shields.io/npm/dm/cordierite?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/cordierite
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: ./CONTRIBUTING.md
[chat-badge]: https://img.shields.io/discord/426714625279524876.svg?style=for-the-badge
[chat]: https://discord.gg/xgGt7KAjxv
