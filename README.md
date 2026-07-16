### Expose app tools securely - no debug menus in the binary

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

Cordierite exists so **developers, QA, and automation** can drive **registered tools** and influence **in-app state** from a **CLI or agent** - without shipping hidden **debug screens**, secret gestures, or admin panels inside the app. The app exposes only the **tool surface you define** in code; control stays behind a long-lived **daemon** that owns a pinned `wss://` listener and a hardened local control plane, so the same tools are reachable from a **terminal** and from an **MCP-speaking agent** (Claude Code, Cursor, CI) alike.

## Why it exists

Shipping ad-hoc debug UIs in production builds is risky: they leak intent, widen attack surface, and are hard to gate consistently. Cordierite inverts that: **production-capable** builds can still participate in Cordierite **when a trusted host is available**, because trust is **not** "anyone on Wi-Fi" or "whoever crafted a link" - it is **TLS + SPKI pinning** to identities you embed, plus **short-lived session bootstrap** so deep links are hints, not proof of authority. A single **`cordierite`** daemon absorbs common dev-loop churn - Metro reloads, backgrounding, and network flaps - by suspending and resuming sessions instead of dying with them, and serves any number of devices at once. Resume credentials live only in the native app process: process death requires a fresh bootstrap link.

## Security

- **No backdoor UI**: nothing extra in the app UI for attackers to discover; capability is **tool APIs + transport**, not mystery menus.
- **Encrypted transport**: `wss://` end-to-end; no cleartext control traffic on the wire.
- **Pinned server identity**: the native client matches your daemon's public key (SPKI) against an embedded pin *set*; IP, DNS, and deep-link origin are not enough to impersonate it.
- **Session bootstrap**: one-time, session-bound channel after claim - appropriate for production when pins and provisioning match your threat model.
- **Hardened local control plane**: the CLI and MCP server talk to the daemon over a Unix domain socket gated by filesystem permissions (`0700` directory, `0600` socket) - not an open localhost port.
- **Policy + audit**: production deployments can deny classes of tool by annotation (`destructiveHint`) or by name, and every call is appended to an audit log regardless of outcome. See [`docs/SECURITY.md`](docs/SECURITY.md) for the full threat model and a key-rotation runbook.

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

### 1. Install the packages

Install the CLI where the operator, test runner, or agent will run it:

```bash
npm install -g cordierite
```

Install the React Native package in your app:

```bash
npm install @cordierite/react-native zod
```

### 2. Generate a daemon key and app pin

```bash
cordierite keygen
```

This writes an unencrypted PEM private key to `~/.cordierite/key.pem` (override with `--out`) and prints a `sha256/...` SPKI fingerprint. Copy that value into the app configuration as a trusted Cordierite pin - see [`docs/SECURITY.md`](docs/SECURITY.md) for what this key protects and how to rotate it later.

### 3. Configure the app

For Expo, add the config plugin and the generated pin to `app.json` / `app.config.*`:

```json
{
  "expo": {
    "scheme": "myapp",
    "plugins": [
      [
        "@cordierite/react-native",
        {
          "cliPins": ["sha256/REPLACE_WITH_KEYGEN_OUTPUT"],
          "allowPrivateLanOnly": true
        }
      ]
    ]
  }
}
```

For bare React Native, configure the equivalent native keys:

- iOS `Info.plist`: `CordieriteCliPins` and optionally `CordieriteAllowPrivateLanOnly`
- Android `<application>` meta-data: `com.callstackincubator.cordierite.CLI_PINS` and optionally `com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY`

Your app also needs a URL scheme, and that scheme must match the one you pass to `cordierite link --scheme ...` (or set once in `~/.cordierite/config.json`'s `"scheme"` field).

After changing native configuration, rebuild the app. Use a **development build** or bare native app. **Expo Go** is not enough.

### 4. Import Cordierite in the JS entry point

Import the side-effect entry once near your app's entry point so the deep-link bootstrap listener installs on startup:

```ts
import "@cordierite/react-native/auto";
```

### 5. Define and register tools

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

### 6. Bootstrap a session and invoke a tool

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

### 7. The MCP one-liner

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
