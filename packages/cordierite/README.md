[![Cordierite][cordierite-banner]][repo]

### Drive app tools without shipping debug UI

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

The **`cordierite`** package is the **operator side** of Cordierite: run a **TLS-terminated WebSocket host**, create **bootstrap sessions**, and **list, inspect, and invoke tools** registered in the React Native app—so **developers, QA, and agents** can steer state from a terminal or script **instead of hidden in-app debug menus**.

## Why use this package

- **Host + session flow**: `host` serves **`wss://`** with a certificate generated from your private key and the resolved local IP; the app follows the deep link and claims a **short-lived** pending session.
- **Tooling from the shell**: `tools` and `invoke` talk to the device-side registry once the session is active—same conceptual surface **automation** uses.
- **Fits production-minded apps**: the app still only exposes **what you register**; trust boundaries are **pins + TLS** on the client (see [HANDSHAKE.md][handshake]).

## Security notes

- **You hold the private key** for the host cert; the app pins the matching **SPKI**—no cleartext control plane, no trust in “just” the deep link or LAN.
- **Bootstrap payloads** are **hints**; authorization to speak to your host comes from **TLS + pinning**, not from payload secrecy alone.

## Key setup

Generate a host key with:

```bash
cordierite keygen
```

The command writes an unencrypted PEM private key (PKCS#8) and prints the exact `sha256/...` SPKI fingerprint your app should place into `cliPins`. Use the generated file with `cordierite host --tls-key ...`.

## Commands (overview)

| Command | Role |
| --- | --- |
| `host` | Start the Cordierite **`wss://`** host (generated cert, private key, scheme, optional open-on-macOS). |
| `connect` | Validate a **base64url binary v1** bootstrap payload. |
| `keygen` | Interactively generate a host private key and print the app fingerprint for `cliPins`. |
| `session` | Show the currently active host session. |
| `tools` | **List** tools on the connected device or **inspect** one by name. |
| `invoke` | **Invoke** a device tool with JSON input. |

Global options include **`--json`** for machine-readable output. See **`cordierite --help`** after install.

## Programmatic use

The package exports **`runCli`**, **`createCli`**, and command helpers from [`src/index.ts`](src/index.ts) so you can embed the same behavior in **Node, Bun, Deno, or other JS runtimes** that can execute the bundle and open TLS sockets.

## Related packages

- **[@cordierite/react-native](../react-native/README.md)** — native app client + Expo plugin.
- **[@cordierite/shared](../shared/README.md)** — shared library used by the CLI and React Native integration (dependency of this package).

## Documentation

- [Handshake & security model][handshake]
- [Monorepo README](../../README.md)

## Made with ❤️ at Callstack

`cordierite` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[cordierite-banner]: https://img.shields.io/badge/Cordierite-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/cordierite
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=cordierite&utm_term=readme-with-love
[handshake]: https://github.com/callstackincubator/cordierite/blob/main/docs/HANDSHAKE.md
[license-badge]: https://img.shields.io/npm/l/cordierite?style=for-the-badge
[license]: https://github.com/callstackincubator/cordierite/blob/main/LICENSE
[npm-downloads-badge]: https://img.shields.io/npm/dm/cordierite?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/cordierite
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/cordierite/blob/main/CONTRIBUTING.md
[chat-badge]: https://img.shields.io/discord/426714625279524876.svg?style=for-the-badge
[chat]: https://discord.gg/xgGt7KAjxv
