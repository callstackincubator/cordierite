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
- **Optional `allowPrivateLanOnly`**: when enabled, bootstrap must target **private IPv4**—a **dev-hardening** switch, not a claim that Cordierite is LAN-only.

## Getting started

> [!NOTE]
> Use a **development build** or bare native app. **Expo Go** is not enough—this library ships native code and pinning configuration.

Install with your package manager (`npm`, `yarn`, `pnpm`, …). Add the **`react-native-cordierite`** config plugin to Expo config with **`cliPins`** (required) and optionally **`allowPrivateLanOnly`**; then run your usual **prebuild** so plist and manifest receive the values. For bare React Native, autolink the module and set the equivalent native keys—field names and semantics mirror the plugin (see [app.plugin.js](app.plugin.js)).

**Bare React Native — native keys**

iOS `Info.plist`:

| Key | Purpose |
| --- | ------- |
| `CordieriteCliPins` | String array of `sha256/...` SPKI pins |
| `CordieriteAllowPrivateLanOnly` | Boolean; if true, bootstrap host must be private IPv4 |

Android `<application>` meta-data:

| Name | Purpose |
| --- | ------- |
| `com.callstackincubator.cordierite.CLI_PINS` | JSON array string of pin values |
| `com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY` | `"true"` / `"false"` |

Empty or missing pins fail at configuration time. Wire **deep links** so the OS can open your app with the host’s bootstrap URL.

**Bootstrap connection:** importing this package registers React Native `Linking` listeners that watch for URLs with a `cordierite` query parameter, parse the binary v1 payload, and call `connect` when the client is idle. You do not need your own `Linking` handler for the default flow.

**Errors:** use `addCordieriteErrorListener` if you want callbacks when bootstrap parsing or that automatic `connect` fails.

**Tools:** call `registerTool(descriptor, handler)` with Standard Schema compatible `input_schema` and `output_schema` values so the host can invoke your tools after the session is active. `zod` v4 works well here and is used in the playground example.

```ts
import { registerTool } from "react-native-cordierite";
import { z } from "zod";

registerTool(
  {
    name: "sum",
    description: "Add two numeric values",
    input_schema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    output_schema: z.object({
      total: z.number(),
    }),
  },
  async ({ a, b }) => ({
    total: a + b,
  }),
);
```

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