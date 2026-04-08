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

### 2. Generate a host key and copy the app pin

Generate a matching host key and pin with:

```bash
cordierite keygen
```

Use the printed fingerprint value verbatim in `cliPins`.

### 3. Configure native pinning and app scheme

#### Expo

Add the **`@cordierite/react-native`** config plugin to Expo config with **`cliPins`** (required) and optionally **`allowPrivateLanOnly`**:

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

Then run your normal prebuild / rebuild flow so native config receives those values.

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
| `com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY` | `"true"` / `"false"` |

Empty or missing pins fail at configuration time. Wire **deep links** so the OS can open your app with the host’s bootstrap URL, and make sure the app scheme matches the value you will pass to `cordierite host --scheme ...`.

### 4. Import Cordierite in the JS entry point

Import the package in the app entry point so the default bootstrap listener is installed during startup:

```ts
import "@cordierite/react-native";
```

This side-effect import installs the default React Native `Linking` listener for Cordierite bootstrap URLs.

**Bootstrap connection:** importing this package registers React Native `Linking` listeners that watch for URLs with a `cordierite` query parameter, parse the binary v1 payload, and call `connect` when the client is idle. You do not need your own `Linking` handler for the default flow.

**Errors:** use `addCordieriteErrorListener` if you want callbacks when bootstrap parsing or that automatic `connect` fails.

### 5. Define tools in app startup code

Call `registerTool({ ... })` with Standard Schema compatible `inputSchema` and `outputSchema` values plus a `handler` so the host can invoke your tools after the session is active. `zod` v4 works well here and is used in the playground example.

```ts
import "@cordierite/react-native";
import { useEffect } from "react";
import { registerTool } from "@cordierite/react-native";
import { z } from "zod";

export function CordieriteBootstrap() {
  useEffect(() => {
    const registration = registerTool({
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
    });

    return () => {
      registration.remove();
    };
  }, []);

  return null;
}
```

Mount that component near app startup, or register from another module that loads on startup. The host can only list and invoke tools that your app has already registered.

### 6. Start the host and test the flow

Run the host with the key generated by `cordierite keygen`:

```bash
cordierite host --tls-key ./dev-key.pem --scheme myapp
```

Open the printed bootstrap deep link in the app, then inspect and invoke tools with the returned `session_id`:

```bash
cordierite tools --session-id <session_id>
cordierite invoke sum --session-id <session_id> --input '{"a":2,"b":3}'
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
