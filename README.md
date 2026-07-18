### Expose app tools securely - no debug menus in the binary

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

Cordierite exists so **developers, QA, and automation** can drive **registered tools** and influence **in-app state** from a **CLI or agent** - without shipping hidden **debug screens**, secret gestures, or admin panels inside the app. The app exposes only the **tool surface you define** in code; control stays behind a long-lived **daemon** that owns a pinned `wss://` listener and a hardened local control plane, so the same tools are reachable from a **terminal** and from an **MCP-speaking agent** (Claude Code, Cursor, CI) alike.

## Why it exists

Shipping ad-hoc debug UIs in production builds is risky: they leak intent, widen attack surface, and are hard to gate consistently. Cordierite inverts that: **production-capable** builds can still participate in Cordierite **when a trusted host is available**, because trust is **not** "anyone on Wi-Fi" or "whoever crafted a link" - it is **TLS + SPKI pinning** to identities you embed, plus **short-lived session bootstrap** so deep links are hints, not proof of authority. A single **`cordierite`** daemon absorbs common dev-loop churn - Metro reloads, backgrounding, and network flaps - by suspending and resuming sessions instead of dying with them, and serves any number of devices at once. Resume credentials live only in the native app process: process death requires a fresh bootstrap link.

## Security

- **No backdoor UI**: nothing extra in the app UI for attackers to discover; capability is **tool APIs + transport**, not mystery menus.
- **Encrypted transport**: `wss://` end-to-end; no cleartext control traffic on the wire.
- **Pinned server identity**: when `cliPins` is configured, the native client matches your daemon's public key (SPKI) against an embedded pin *set*; IP, DNS, and deep-link origin are not enough to impersonate it. On a debug build with no `cliPins` configured, the client instead trusts the pin carried by the bootstrap link itself - see "Dev mode, zero config" below.
- **Session bootstrap**: one-time, session-bound channel after claim - appropriate for production when pins and provisioning match your threat model.
- **Hardened local control plane**: the CLI and MCP server talk to the daemon over a Unix domain socket gated by filesystem permissions (`0700` directory, `0600` socket) - not an open localhost port.
- **Policy + audit**: production deployments can deny classes of tool by annotation (`destructiveHint`) or by name, and every call is appended to an audit log regardless of outcome. See [`docs/SECURITY.md`](docs/SECURITY.md) for the full threat model and a key-rotation runbook.
- **Inert by default in release builds**: the native module registers (Android) / compiles in (iOS) only in debug builds unless you deliberately opt in - see "Hardening for production / internal builds" below.

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

On a **debug build**, that's the whole setup: no `cordierite keygen`, no config plugin, no pins. The daemon auto-generates its own key on first run, and the app trusts the pin carried by the bootstrap link itself (see "Dev mode, zero config" below). Production and internal-distribution release builds need the extra hardening step in "Hardening for production / internal builds" further down - **do that before you ship a release build**, since Cordierite ships inert in release builds until you opt in.

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

None of the steps above touched `cordierite keygen`, the config plugin, or a `cliPins` value, and that's intentional on a **debug build**:

- The daemon generates `~/.cordierite/key.pem` itself the first time it starts if the file doesn't already exist, and prints its `sha256/...` fingerprint.
- `cordierite link` composes that fingerprint into the deep link as a separate `pin` query param, alongside the existing binary `cordierite` bootstrap payload (which is unchanged - older app builds that don't know about `pin` just ignore it).
- The native client trusts that link-carried pin only when **all three** hold: no build-time pins are configured (no `cliPins` / `CLI_PINS` meta-data written into this build), the build is debuggable (iOS `#if DEBUG`, Android `FLAG_DEBUGGABLE`), and the bootstrap link actually carries a `pin`. It then logs, unconditionally: `Cordierite: trusting pin from bootstrap link (dev mode). Release builds require embedded cliPins.`
- The moment you configure `cliPins` (via the plugin or the native keys), that embedded set always wins and the link's `pin` is ignored outright - it can only fill in trust when none was configured, never widen it.

This is deliberately weaker than pinned trust: it anchors trust in "whoever handed you this link", not in a key you embedded ahead of time. That's an acceptable tradeoff for a debug build on your own machine or LAN, which is why it's off by default outside debug builds - see [`docs/SECURITY.md`](docs/SECURITY.md)'s "Dev trust mode" section for the full threat-model writeup.

## Hardening for production / internal builds

Cordierite ships **inert by default** in release builds: the native module doesn't register at all (Android's `CordieritePackage` returns no module; iOS compiles the implementation out entirely), and the JS-side public API degrades to the exact `./noop` entry's behavior (one warning log, no throws). If you want Cordierite to work in a release build - production, TestFlight/internal-track, or any other non-debug build - you must opt in deliberately and, unlike the debug-mode flow above, configure embedded pins:

For Expo, add the config plugin with `cliPins` and `enableInReleaseBuilds: true` to `app.json` / `app.config.*`:

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
          "enableInReleaseBuilds": true
        }
      ]
    ]
  }
}
```

Generate that pin with:

```bash
cordierite keygen
```

This writes an unencrypted PEM private key to `~/.cordierite/key.pem` (override with `--out`) and prints a `sha256/...` SPKI fingerprint - copy that value into `cliPins`. See [`docs/SECURITY.md`](docs/SECURITY.md) for what this key protects and how to rotate it later. The plugin refuses `enableInReleaseBuilds: true` with an empty or missing `cliPins` - a release build with the module enabled but no pins would have no way to trust anything, so that combination is rejected at config time.

For bare React Native, configure the equivalent native keys:

- iOS `Info.plist`: `CordieriteCliPins` (required alongside the flag below), optionally `CordieriteAllowPrivateLanOnly`, and the `CORDIERITE_ENABLE_RELEASE` build settings described in the [package README](packages/react-native/README.md#hardening-for-production--internal-builds) (`SWIFT_ACTIVE_COMPILATION_CONDITIONS` for `CordieriteTurboBridge.swift`, `GCC_PREPROCESSOR_DEFINITIONS` for `RCTNativeCordierite.mm`) on the Cordierite pod's Release configuration.
- Android `<application>` meta-data: `com.callstackincubator.cordierite.CLI_PINS`, optionally `com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY`, and `com.callstackincubator.cordierite.ENABLE_IN_RELEASE` set to `true`.

After changing native configuration, rebuild the app.

**Resulting behavior matrix:**

| Build   | Default                                                        | Opt-in                                            |
| ------- | --------------------------------------------------------------- | -------------------------------------------------- |
| Debug   | Fully active, zero config (link-carried pin trusted)            | `cliPins` for pinned trust instead                 |
| Release | Inert - module unregistered (Android) / compiled out (iOS)      | `enableInReleaseBuilds` + `cliPins` → hardened     |

**iOS custom build configurations:** a build configuration other than the stock Debug/Release pair (e.g. a "Staging" scheme) does not automatically get Xcode's `DEBUG` compilation condition, so Cordierite is off there by default too, exactly as in Release. The config plugin's `enableInReleaseBuilds: true` covers these too - it applies `CORDIERITE_ENABLE_RELEASE` to every one of the Cordierite pod's build configurations, not only the one literally named `Release` (matching Android, where `ENABLE_IN_RELEASE` covers every non-debuggable build variant, custom build types included). Bare-RN setups need the equivalent build settings added to that custom configuration by hand.

## Migration: upgrading past the opt-in hardening release

This is a breaking change (semver major) for anyone shipping release builds with Cordierite already wired up:

- **Production/internal release users must act.** Add `enableInReleaseBuilds: true` (config plugin) or the bare-RN equivalents (`ENABLE_IN_RELEASE` manifest meta-data + the `CORDIERITE_ENABLE_RELEASE` pod build flags) to your existing configuration, and keep `cliPins` as they were. Skip this and your very next release build ships with Cordierite silently inert - the app builds and runs fine, but no bootstrap link will ever connect.
- **Debug-only users can simplify.** If you only ever used Cordierite in debug builds, you can delete the config plugin entry and `cliPins` entirely - the daemon's auto-generated key and the link-carried pin now cover that case with no configuration at all.
- **No package version bump is included in this change itself** - it ships as part of whatever release the maintainers cut next; check the changelog for the version that first includes default-inert release builds before assuming your build is affected.

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
