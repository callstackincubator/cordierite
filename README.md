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

Clone the repo and install with your usual workspace workflow. The [playground](playground/README.md) is the reference dev app; [playground/certs](playground/certs/README.md) explains dev TLS and pin rotation.

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
