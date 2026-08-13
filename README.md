### Expose app tools securely - no debug menus in the binary

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

Cordierite exists so **developers, QA, and automation** can drive **registered tools** and influence **in-app state** from a **CLI or agent** - without shipping hidden **debug screens**, secret gestures, or admin panels inside the app. The app exposes only the **tool surface you define** in code; control stays behind a long-lived **daemon** that owns a pinned `wss://` listener and a hardened local control plane, so the same tools are reachable from a **terminal** and from an **MCP-speaking agent** (Claude Code, Cursor, CI) alike.

## Why it exists

Shipping ad-hoc debug UIs in production builds is risky: they leak intent, widen attack surface, and are hard to gate consistently. Cordierite inverts that: **production-capable** builds can still participate in Cordierite **when a trusted host is available**, because trust is **not** "anyone on Wi-Fi" or "whoever crafted a link" - it is **TLS + SPKI pinning** to identities you embed, plus **short-lived session bootstrap** so deep links are hints, not proof of authority. A single **`cordierite`** daemon absorbs common dev-loop churn - Metro reloads, backgrounding, and network flaps - by suspending and resuming sessions instead of dying with them, and serves any number of devices at once. Resume credentials live only in the native app process: process death requires a fresh bootstrap link.

## Security

- **No backdoor UI**: nothing extra in the app UI for attackers to discover; capability is **tool APIs + transport**, not mystery menus.
- **Encrypted transport**: `wss://` end-to-end; no cleartext control traffic on the wire.
- **Pinned server identity**: with `trust: "pin"` (the default once `cliPins` is configured), the native client matches your daemon's public key (SPKI) against an embedded pin *set*; IP, DNS, and deep-link origin are not enough to impersonate it. With `trust: "link"` (the default with no `cliPins`), the client instead trusts the pin carried by the bootstrap link itself, for that session only - see "Dev mode, zero config" below. `trust` is an explicit config value, not derived from whether the build happens to be debuggable.
- **Session bootstrap**: one-time, session-bound channel after claim - appropriate for production when pins and provisioning match your threat model.
- **Hardened local control plane**: the CLI and MCP server talk to the daemon over a Unix domain socket gated by filesystem permissions (`0700` directory, `0600` socket) - not an open localhost port.
- **Policy + audit**: operator ergonomics on the daemon side - deny classes of tool by annotation (`destructiveHint`) or by name, and every call is appended to an audit log regardless of outcome. This runs on the operator's machine, the trust boundary itself, so it is not a substitute for the app-side control below. See [`docs/SECURITY.md`](docs/SECURITY.md) for the full threat model and a key-rotation runbook.
- **Explicit inclusion, not a hidden build-type gate**: whether Cordierite's native code ships in a build at all is decided in one place - the app's autolinking configuration - not by any runtime debuggable check. See "Whether Cordierite is in your build, and what it trusts" below.

## Monorepo layout

| Package | Role |
| --- | --- |
| [`cordierite`](packages/cordierite/README.md) | CLI, daemon, and MCP server |
| [`@cordierite/shared`](packages/shared/README.md) | Wire protocol v2 types shared by the CLI and React Native |
| [`@cordierite/react-native`](packages/react-native/README.md) | TurboModule client + Expo config plugin |

Clone the repo and install with pnpm (`pnpm install`). The [playground](playground/README.md) is the reference dev app - it's also the fastest way to see the whole flow working end to end.

## Getting started

Cordierite has two sides:

- the **operator/agent** side, where you run the `cordierite` CLI (which transparently starts its own daemon) or add `cordierite mcp` to an agent's MCP config
- the **app** side, where your React Native app imports `@cordierite/react-native` and registers tools

With no config at all, that's the whole setup: no `cordierite keygen`, no config plugin, no pins. The daemon auto-generates its own key on first run, and the app trusts the pin carried by the bootstrap link itself (see "Dev mode, zero config" below). This has nothing to do with debug vs. release - Cordierite ships in every build unless you deliberately exclude it, and it trusts whatever `trust` config says, regardless of build type. Before you ship a build you don't want carrying Cordierite (or don't want trusting link-carried pins), read "Whether Cordierite is in your build, and what it trusts" further down - **decide that deliberately**, since the default is inclusion with dev-mode trust, not the other way around.

### 1. Install the packages

Install the CLI where the operator, test runner, or agent will run it:

```bash
npm install -g cordierite
```

Install the React Native package in your app:

```bash
npm install @cordierite/react-native zod
```

### 2. Give the app a URL scheme

Cordierite's bootstrap deep link needs somewhere to land, so the app needs a URL scheme. For Expo, set it in `app.json` / `app.config.*`:

```json
{
  "expo": {
    "scheme": "myapp"
  }
}
```

For bare React Native, wire up the equivalent native URL-scheme handling for your platform. That scheme must match the one you pass to `cordierite link --scheme ...` (or set once in `~/.cordierite/config.json`'s `"scheme"` field).

Use a **development build** or bare native app. **Expo Go** is not enough.

### 3. Import Cordierite in the JS entry point

Import the side-effect entry once near your app's entry point so the deep-link bootstrap listener installs on startup:

```ts
import "@cordierite/react-native/auto";
```

### 4. Define and register tools

```ts
import "@cordierite/react-native/auto";
import { useCordieriteTool } from "@cordierite/react-native";
import { z } from "zod";

export function CordieriteBootstrap() {
  useCordieriteTool(
    {
      name: "sum",
      description: "Add two numbers inside the app.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ total: z.number() }),
      handler: async ({ a, b }) => ({ total: a + b }),
    },
    []
  );

  return null;
}
```

Mount that component near app startup, or register tools from another early-loading module. Cordierite only exposes the tools you register.

### 5. Bootstrap a session and invoke a tool

`cordierite` auto-spawns its daemon on first use, so most commands just work. `link` needs to know the app's URL scheme - pass it once with `--scheme`, or set it once in `~/.cordierite/config.json`'s `"scheme"` field and drop the flag from every command below:

```bash
cordierite link --scheme myapp --qr
```

Scan the printed QR (or open the deep link) on the device. On a simulator/emulator, skip the deep link entirely:

```bash
cordierite link --scheme myapp --open ios-sim     # or: --open android
```

Once the app claims the session, list and call its tools - no session id needed when only one session is active:

```bash
cordierite tools
cordierite invoke sum --input '{"a":2,"b":3}'
```

Use `cordierite ls` to see aliases when more than one device is connected, and pass an alias or session id as the optional selector (`cordierite invoke pixel-8 sum --input '{"a":2,"b":3}'`).

### 6. The MCP one-liner

For an agent instead of a human operator, point its MCP config at the CLI - no separate server to run, the daemon auto-spawns the same way:

```json
{
  "mcpServers": {
    "cordierite": {
      "command": "cordierite",
      "args": ["mcp"]
    }
  }
}
```

Add that to Claude Code's or Cursor's MCP config and the connected app's tools appear as MCP tools automatically (`tools/list` reflects the live registry; a `cordierite_connect` tool lets the agent mint and deliver a bootstrap link itself, and `cordierite_wait_for_session` lets it wait for the device to claim it - no shell access required).

### Dev mode, zero config

None of the steps above touched `cordierite keygen`, the config plugin, or a `cliPins` value, and that's intentional whenever a build has no embedded pins - **in any build type**, not just a locally-run debug build:

- The daemon generates `~/.cordierite/key.pem` itself the first time it starts if the file doesn't already exist, and prints its `sha256/...` fingerprint.
- `cordierite link` composes that fingerprint into the deep link as a separate `pin` query param, alongside the existing binary `cordierite` bootstrap payload (which is unchanged - older app builds that don't know about `pin` just ignore it).
- With no `cliPins`/`CLI_PINS` configured, the effective `trust` mode defaults to `"link"` (explicit `trust: "link"` behaves identically): the native client trusts a pin carried by the bootstrap link, for that one session only, and logs unconditionally: `Cordierite: trusting pin from bootstrap link (dev mode). Release builds require embedded cliPins.` This no longer depends on whether the build is debuggable - only on whether pins are configured.
- The moment you configure `cliPins`, that embedded set always wins regardless of `trust`, and the link's `pin` is ignored outright - config can only *narrow* trust, never widen it back to link TOFU.

This is deliberately weaker than pinned trust: it anchors trust in "whoever handed you this link", not in a key you embedded ahead of time. That's an acceptable tradeoff for local development, which is why production and internal-distribution builds should configure `cliPins` rather than relying on the default - see [`docs/SECURITY.md`](docs/SECURITY.md)'s "Trust modes" section for the full threat-model writeup.

## Whether Cordierite is in your build, and what it trusts

Two independent questions, two independent knobs - neither is keyed on debug vs. release.

**1. Is Cordierite's native code in this build at all?** Decided entirely by autolinking, in the app's `package.json` (not `app.json`/`app.config.*` - `expo-modules-autolinking` never reads those for this). By default it's included in every build. To exclude it from a build:

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

Bare React Native, in `react-native.config.js` at the app root:

```js
module.exports = {
  dependencies: { "@cordierite/react-native": { platforms: { ios: null, android: null } } },
};
```

This is a per-prebuild / per-`pod install` decision, not a build-variant flag - flip it from an env var in `app.config.ts` if different builds need different answers. See the [package README](packages/react-native/README.md#compiling-cordierite-out-of-production-builds) for the full recipe (including the JS-side Metro swap, which strips the bundle but not the native binary) and [`docs/CI.md`](docs/CI.md) for `cordierite doctor`, the artifact-level check that verifies the exclusion actually took effect - don't just trust the config by inspection.

> **`expo.autolinking.apple` takes priority over `expo.autolinking.ios`.** `expo-modules-autolinking`'s CocoaPods driver always resolves iOS with `--platform apple`, and an `apple` key in `expo.autolinking` **wins outright over `ios` rather than merging with it** - `ios` is only consulted when `apple` is absent. The recipe above uses `ios`, which works today, but if your app also declares an `expo.autolinking.apple` block for other reasons, put the Cordierite exclude there instead (or in both), since an `apple` entry silently overrides an `ios`-only exclude.

> **Maintainer-shaped setups only:** excluding the package from autolinking on iOS also stops its **codegen** from running for that package. An app that excludes it there but still references the `Cordierite` pod by hand (for example, to attach an XCTest target) will fail to compile - `RCTNativeCordierite.mm` imports the generated `CordieriteSpec.h`, which codegen no longer produces once the module is excluded. Normal consumer apps never hit this; it only bites setups that both exclude and hand-add the pod.

If you also use the `@cordierite/react-native` config plugin, set its `include` option to `false` on every platform you exclude above - the plugin's default (`include: true`) asserts that autolinking still includes the package on **both** `ios` and `android`, and fails prebuild with a copy-pasteable fix if either platform's real autolinking config disagrees with what `include` says:

```json
["@cordierite/react-native", { "include": false }]
```

**2. What does it trust, once it's in the build?** The `trust` config option, independent of platform build type:

```json
["@cordierite/react-native", { "cliPins": ["sha256/..."], "trust": "pin" }]
```

- `trust: "pin"` - only the embedded `cliPins` are trusted. Requires a non-empty `cliPins`; the plugin refuses the combination at config time otherwise, and the native readers refuse it a second time if that check is ever bypassed by hand.
- `trust: "link"` - trust the pin carried by the bootstrap link, per session (see "Dev mode, zero config" above). Default when `cliPins` is absent.
- Any other value (a typo like `"PIN"` or `"pinn"`) is a **hard error**, both at config (prebuild) time and in the native trust-resolution logic - deliberately, so a typo can never silently downgrade an intended `"pin"` config into permissive link TOFU.
- `getCordieriteBuildConfig()` (JS) reports the effective trust mode a running build actually has, read from the exact same native parse `connect()` uses - handy for confirming a release artifact ended up with the config you expected.

For bare React Native, configure the equivalent native keys:

- iOS `Info.plist`: `CordieriteCliPins`, `CordieriteTrust` (`"link"` | `"pin"`), optionally `CordieriteAllowPrivateLanOnly`.
- Android `<application>` meta-data: `com.callstackincubator.cordierite.CLI_PINS`, `com.callstackincubator.cordierite.TRUST`, optionally `com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY`.

Generate a pin with:

```bash
cordierite keygen
```

This writes an unencrypted PEM private key to `~/.cordierite/key.pem` (override with `--out`) and prints a `sha256/...` SPKI fingerprint - copy that value into `cliPins`. See [`docs/SECURITY.md`](docs/SECURITY.md) for what this key protects and how to rotate it later.

After changing native configuration, rebuild the app.

**Resulting matrix (`include` x `trust`, not build-type-keyed):**

| `include` | `trust` | Result |
| --- | --- | --- |
| `true` (default) | `"link"` (default without `cliPins`) | Native code ships; trusts the bootstrap link's pin, per session |
| `true` (default) | `"pin"` | Native code ships; trusts only embedded `cliPins` |
| `false` | n/a | Native code excluded from the build entirely (needs the autolinking exclude above) |

## Migration from 0.3.1

`enableInReleaseBuilds` never shipped in any published release - npm's latest for both packages is `0.3.1`, which has no build-type gating and no `enableInReleaseBuilds` option at all. `0.3.1`'s config plugin also had no `include`/`trust` concept: it required a non-empty `cliPins` unconditionally (`"@cordierite/react-native requires a non-empty cliPins array"` at prebuild otherwise) and only ever trusted those embedded pins - there was no link-carried-pin / zero-config flow at all in `0.3.1`. If you're on `0.3.1` (or older), migrating is:

- **Every `0.3.1` app already has `cliPins` configured** (the plugin made it mandatory), so `trust` defaults to `"pin"` automatically and nothing about what your build trusts changes. You do not need to add `trust: "pin"` explicitly, though doing so is harmless and makes the choice explicit.
- **The zero-config `trust: "link"` flow is new**, not a `0.3.1` behavior carried forward - it only applies to a build with no `cliPins` configured at all, which no real `0.3.1` app has. Nothing to do here unless you want to adopt it for a new, pins-free build variant.
- **`allowPrivateLanOnly`'s default flipped from `false` to `true` (fail-closed).** `0.3.1` defaulted to allowing any address unless you explicitly opted into private-LAN-only; this release defaults to private-LAN-only unless you explicitly opt out. If your `0.3.1` app relies on non-private/remote bootstrap targets and never set `allowPrivateLanOnly` explicitly, set `allowPrivateLanOnly: false` explicitly now to keep that behavior - otherwise those bootstrap attempts will start being rejected.
- **Excluding Cordierite from a build via autolinking is not new** - `expo.autolinking.<platform>.exclude` in `package.json` is a feature of `expo-modules-autolinking` itself and worked the same way against `0.3.1`. What's new in this release is the plugin's own `include` option (default `true`), which asserts that your declared intent matches your real autolinking config and fails prebuild with a copy-pasteable fix when it doesn't - useful, but not required to adopt the exclude recipe itself.
- **If your config ever referenced `enableInReleaseBuilds`,** it never worked on a published version - there is nothing to remove from a real `0.3.1` install. (Only a pre-release build from this repo's `main` branch between `0.3.1` and this release would have had it; that option now throws a config-time error naming its removal if left in place.)

## Security summary

- **Pinning**: the app trusts the daemon by SPKI hash, not IP/DNS/deep-link origin; deep links are bootstrap hints, never proof of authority.
- **Tokens**: pending-session tokens are short-lived, single-use, and compared with `crypto.timingSafeEqual`; a rotating resume token lets a suspended session recover without minting a new link while the native app process remains alive. Resume credentials are process-memory-only and are never persisted to disk.
- **Control plane**: CLI and MCP talk to the daemon over a Unix domain socket (`0700`/`0600`), not an open localhost port.
- **Policy + audit**: production deployments can deny tool classes or specific tools by policy, and every invocation attempt is audited (args hashed, never logged raw).

Full threat model, key-handling rules, and a rotation runbook: [`docs/SECURITY.md`](docs/SECURITY.md).

## Platform matrix

| Surface | Support |
| --- | --- |
| **CLI / daemon / MCP** | any modern JavaScript runtime (Node ≥ 20 semantics) that can run the published package and open a Unix domain socket + TLS `wss://` listener |
| **React Native — iOS** | 15.1+, New Architecture |
| **React Native — Android** | New Architecture, autolinked |
| **React Native — Web** | safe no-op stub only |
| **Windows control plane** | best-effort (named pipe), not yet exercised in CI |

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - the current architecture reference
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) - the wire protocol, byte layouts, message catalog, state machine, close codes
- [`docs/SECURITY.md`](docs/SECURITY.md) - threat model and key rotation runbook
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) - product requirements

## Made with ❤️ at Callstack

`cordierite` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

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
