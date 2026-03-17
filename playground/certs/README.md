[![Cordierite][cordierite-banner]][repo]

### Dev-only TLS trust material for the playground host

[![MIT license][license-badge]][license] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

The Cordierite **`host`** command serves **TLS** using a PEM cert and key (`--tls-cert`, `--tls-key`). This folder holds **development** leaf and key files checked in so the [playground](../README.md) and CLI can agree on trust **without** sharing production secrets.

## Security notes

- **Dev-only**: treat `dev-cert.pem` / `dev-key.pem` as **non-production** credentials for this repo’s playground.
- **Pins must follow the cert**: the app’s **`cliPins`** must match the leaf’s **SPKI**; otherwise pinning correctly **refuses** the connection—exactly what you want if someone swaps the host cert.
- **Rotation**: regenerating the key changes the pin—update Expo config **before** expecting devices to connect.

## What this enables (example)

- **Local host + device**: same Wi‑Fi or tethering; bootstrap may point at a private IP while **`allowPrivateLanOnly`** adds an extra sanity check—optional and **not** a global product constraint.

## Documentation

- [Handshake & pin format](../../docs/HANDSHAKE.md)
- [Playground README](../README.md)
- [react-native-cordierite](../../packages/react-native-cordierite/README.md)

## Getting started

Use the playground script **`generate:dev-tls`** (see `playground/package.json`) to regenerate certs when needed, then refresh **`cliPins`** in `app.json` for **`react-native-cordierite`**. Run **`host`** from the monorepo with paths under `playground/certs/`—the CLI runs in **any standard JS runtime** your workspace uses.

## Platform compatibility

Pins are read by **iOS and Android** in `react-native-cordierite`. PEM files are read by the **host process** on your machine.

## Authors

Part of [Cordierite][repo] at [Callstack][callstack-readme-with-love].

[cordierite-banner]: https://img.shields.io/badge/Cordierite-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/cordierite
[license-badge]: https://img.shields.io/npm/l/react-native-cordierite?style=for-the-badge
[license]: https://github.com/callstackincubator/cordierite/blob/main/LICENSE
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/cordierite/pulls
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=cordierite&utm_term=readme-with-love
