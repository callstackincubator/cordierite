### Expose app tools securely - no debug menus in the binary

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

Cordierite exists so **developers, QA, and automation** can drive **registered tools** and influence **in-app state** from a **CLI or agent host** - without shipping hidden **debug screens**, secret gestures, or admin panels inside the app. The app exposes only the **tool surface you define** in code; control stays on the **other end of a pinned `wss://` session** you initiate when it makes sense (local desk, CI, VPN, or a host on the internet).

## Why it exists

Shipping ad-hoc debug UIs in production builds is risky: they leak intent, widen attack surface, and are hard to gate consistently. Cordierite inverts that: **production-capable** builds can still participate in Cordierite **when a trusted host is available**, because trust is **not** “anyone on Wi‑Fi” or “whoever crafted a link” - it is **TLS + SPKI pinning** to identities you embed, plus **short-lived session bootstrap** so deep links are hints, not proof of authority. The same channel works for **human operators** (CLI), **test automation**, and **agents**.

## Security

- **No backdoor UI**: nothing extra in the app UI for attackers to discover; capability is **tool APIs + transport**, not mystery menus.
- **Encrypted transport**: `wss://` end-to-end; no cleartext control traffic on the wire.
- **Pinned server identity**: the native client matches your host’s public key (SPKI); IP, DNS, and deep-link origin are not enough to impersonate the host.
- **Session bootstrap**: one-time, session-bound channel after claim - appropriate for production when pins and provisioning match your threat model.
- **Current local control limitation**: once a Cordierite host is running, its local control API is currently unauthenticated. Any process in the same operating system that can reach the local control port may talk to Cordierite and invoke tools on the connected app. This is a known limitation today.


## Monorepo layout

| Package | Role |
| --- | --- |
| [`cordierite`](packages/cordierite/README.md) | CLI and host tooling |
| [`@cordierite/shared`](packages/shared/README.md) | Shared library (CLI + React Native) |
| [`@cordierite/react-native`](packages/react-native/README.md) | TurboModule client + optional Expo config plugin |

Clone the repo and install with your usual workspace workflow. The [playground](playground/README.md) is the reference dev app.

## Getting started

Cordierite has two sides:

- the **host** side, where you run the `cordierite` CLI
- the **app** side, where your React Native app imports `@cordierite/react-native` and registers tools

### 1. Install the packages

Install the CLI where the operator, test runner, or agent will run it:

```bash
npm install cordierite
```

Install the React Native package in your app:

```bash
npm install @cordierite/react-native zod
```

### 2. Generate the host key and app pin

Generate a TLS private key for the host:

```bash
cordierite keygen
```

The command prints a `sha256/...` SPKI fingerprint. Copy that value into the app configuration as a trusted Cordierite pin.

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

Your app also needs a URL scheme, and that scheme must match the one you pass to `cordierite host --scheme ...`.

After changing native configuration, rebuild the app. For Expo, use a **development build** or bare native app. **Expo Go** is not enough.

### 4. Import Cordierite in the JS entry point

Import `@cordierite/react-native` in the app entry point so the package installs its deep-link bootstrap listener as soon as the app starts:

```ts
import "@cordierite/react-native";
```

This import should happen in the JS entry file or another module that is guaranteed to load during app startup.

### 5. Define and register tools

Register tools from app startup code. A small example:

```ts
import "@cordierite/react-native";
import { useEffect } from "react";
import { registerTool } from "@cordierite/react-native";
import { z } from "zod";

export function CordieriteBootstrap() {
  useEffect(() => {
    const sumTool = registerTool({
      name: "sum",
      description: "Add two numbers inside the app.",
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
      sumTool.remove();
    };
  }, []);

  return null;
}
```

Mount that component near app startup, or register tools from another early-loading module. Cordierite only exposes the tools you register.

### 6. Start the host

Run the host with the private key from `cordierite keygen` and your app scheme:

```bash
cordierite host --tls-key ./dev-key.pem --scheme myapp
```

The host prints a bootstrap deep link and session details. Open that deep link in the app. On macOS simulator you can also use `--open`.

### 7. Verify the session and invoke a tool

Once the app claims the session, use the returned `session_id` with the CLI:

```bash
cordierite tools --session-id <session_id>
cordierite invoke sum --session-id <session_id> --input '{"a":2,"b":3}'
```

If setup is correct, the app connects over pinned `wss://`, the host lists the registered tools, and `invoke` returns the tool result.

## Platform compatibility

- **CLI / host**: any modern **JavaScript runtime** that can run the published package and open TLS sockets.
- **React Native**: iOS and Android with **New Architecture**; web is a safe stub only.

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
