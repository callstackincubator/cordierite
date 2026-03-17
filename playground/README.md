[![Cordierite][cordierite-banner]][repo]

### Reference app: tools from the CLI—no debug UI

[![MIT license][license-badge]][license] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

The playground is an Expo **development build** that demonstrates Cordierite’s model: **host-driven tools and state** over **pinned `wss://`**, started from a **bootstrap deep link**—no extra debug screens in the app, same ideas as in **production** builds.

## Why it’s here

- **End-to-end check** that SPKI pins in `app.json` match the host TLS material ([certs](certs/README.md)) while tools run from the **CLI**, not in-app menus.
- **Safe local defaults**: you can enable **private-LAN-only** bootstrap checks while iterating—same knobs as production, not a statement that Cordierite only works offline or on one subnet.
- **UI sandbox** (Expo Router) for experimenting with session state and tooling around the client.
- **No manual bootstrap wiring**: importing `react-native-cordierite` attaches `Linking` listeners; opening the host’s deep link is enough to start `connect` (see package README).

## What you’ll do (examples)

- **Happy path**: start the host (any JS runtime), start Metro / Dev Client, open the bootstrap link, confirm the session reaches **active** and messages flow.
- **Pin mismatch**: change the cert without updating pins—expect a **clean failure** at TLS (pinning doing its job).
- **Policy toggle**: flip private-LAN enforcement to see how bootstrap validation behaves on device vs simulator.

## Documentation

- [Monorepo README](../README.md)
- [react-native-cordierite](../packages/react-native-cordierite/README.md)
- [Handshake](../docs/HANDSHAKE.md)
- [Dev TLS & rotation](certs/README.md)

## Getting started

Install dependencies, then start Expo with a **development build** (not Expo Go). Run the Cordierite **host** from the monorepo with the playground PEM paths and align **`cliPins`** with the current leaf SPKI—details and rotation steps are in [certs/README.md](certs/README.md).

## Platform compatibility

- **iOS** and **Android** development builds, New Architecture.
- **Web**: Cordierite client is a stub; this app is not targeting web sessions.

## Authors

Ships with [Cordierite][repo] · [Callstack][callstack-readme-with-love].

[cordierite-banner]: https://img.shields.io/badge/Cordierite-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/cordierite
[license-badge]: https://img.shields.io/npm/l/react-native-cordierite?style=for-the-badge
[license]: https://github.com/callstackincubator/cordierite/blob/main/LICENSE
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/cordierite/pulls
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=cordierite&utm_term=readme-with-love
