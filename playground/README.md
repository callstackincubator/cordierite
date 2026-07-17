[![Cordierite][cordierite-banner]][repo]

### Reference app: tools from the CLI—no debug UI

[![MIT license][license-badge]][license] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

The playground is an Expo **development build** that demonstrates Cordierite's v2 model: an
always-on **daemon** on your machine, an app that claims a **pinned `wss://`** session from a
bootstrap deep link, and a thin **CLI/MCP** surface driving tools registered in JS—no extra debug
screens in the app, same ideas as in **production** builds.

## Why it's here

- **End-to-end check** that SPKI pins in `app.json` match the daemon's key material while tools
  run from the **CLI** (or an MCP client), not in-app menus.
- **Safe local defaults**: `allowPrivateLanOnly` stays enabled while iterating—same knob as
  production, not a statement that Cordierite only works offline or on one subnet.
- **Resume smoke test**: the app uses `@cordierite/react-native/auto`, so a Metro reload suspends
  and resumes the session automatically with the same alias—no new deep link needed while the
  native app process stays alive.
- **UI sandbox** (Expo Router) with two tabs: **Tools** (registers demo tools, renders the live
  registry) and **Status** (connection state, alias, error feed, and a manual event post).

## Getting started

Everything below runs from the monorepo root unless noted. Use a **development build**, not Expo
Go—this app ships native pinning code.

### 1. Use the committed playground host identity

The playground ships an intentionally non-secret TLS host-key fixture at
`.cordierite/key.pem`; its matching SPKI pin is already in `app.json`. The launcher below selects
that isolated state directory and corrects the key mode after checkout, so no key generation or
configuration changes are needed. Do not use this identity for another app or any production
environment.

### 2. Build and run the dev client

```sh
pnpm exec expo run:ios
# or
pnpm exec expo run:android
```

This also starts Metro. The daemon auto-spawns on first CLI/MCP use—no separate `daemon start`
step required for the smoke test below.

### 3. Bootstrap a session

- **iOS Simulator**: `pnpm run playground:cordierite -- link --open ios-sim`
- **Android emulator**: `pnpm run playground:cordierite -- link --open android`
- **Physical device**: `pnpm run playground:cordierite -- link --qr`, then scan the QR code with the device's camera (it
  must be on the same LAN as the daemon, or `allowPrivateLanOnly` will reject it)

The **Status** tab should flip to `active` with an alias once the app claims the session.

### 4. Drive it from the CLI

```sh
pnpm run playground:cordierite -- ls
pnpm run playground:cordierite -- tools
pnpm run playground:cordierite -- invoke sum --input '{"a":1,"b":2}'
pnpm run playground:cordierite -- invoke reset_counter --input '{}'   # destructive; denied if policy.destructive=deny
pnpm run playground:cordierite -- invoke slow_task --input '{}'       # watch progress with events --follow
pnpm run playground:cordierite -- invoke throwing_tool --input '{}'   # exercises tool_execution_error
pnpm run playground:cordierite -- events --follow
```

Tap **Send playground_ping** on the Status tab while `events --follow` is running to see the
`app_event` show up on the stream.

### 5. Try the resume behavior

With a session active, trigger a Metro reload (press `r` in the Metro terminal, or shake the
device and choose Reload). The Status tab should show `reconnecting` then `active` again with the
**same alias**—no new `cordierite link` needed. Keep the native app process alive: the resume
lease exists only in native process memory, so killing/relaunching the app requires a new link.
The daemon-side session grace window (`graceSeconds` in `config.json`) starts when the transport
suspends/disconnects.

## Platform compatibility

- **iOS** and **Android** development builds, New Architecture.
- **Web**: Cordierite client is a stub; this app is not targeting web sessions.

## Documentation

- [Monorepo README](../README.md)
- [Architecture](../docs/ARCHITECTURE.md)
- [@cordierite/react-native](../packages/react-native/README.md)
- [cordierite (CLI/daemon/MCP)](../packages/cordierite/README.md)

## Authors

Ships with [Cordierite][repo] · [Callstack][callstack-readme-with-love].

[cordierite-banner]: https://img.shields.io/badge/Cordierite-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/cordierite
[license-badge]: https://img.shields.io/npm/l/%40cordierite%2Freact-native?style=for-the-badge
[license]: https://github.com/callstackincubator/cordierite/blob/main/LICENSE
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/cordierite/pulls
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=cordierite&utm_term=readme-with-love
