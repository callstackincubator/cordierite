[![Cordierite][cordierite-banner]][repo]

### Drive app tools without shipping debug UI

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

The **`cordierite`** package is the operator/agent side of Cordierite: a long-lived **daemon** that owns a TLS-terminated `wss://` listener and any number of device sessions, a **CLI** and an **MCP server** that are both thin RPC clients of that daemon, and the **key management** that ties it all together — so **developers, QA, and agents** can steer app state from a terminal or an MCP-speaking client **instead of a hidden in-app debug menu**.

## Why use this package

- **One daemon, many devices**: `cordierite` auto-spawns its daemon on first use; it serves every connected device on one `wss://` port and survives Metro reloads, backgrounding, and network flaps by suspending and resuming sessions instead of dying with them.
- **Same surface for humans and agents**: the CLI (`tools`, `invoke`, `events`, ...) and `cordierite mcp` both talk to the daemon over the same RPC methods — an agent sees the same tools a human operator does.
- **Hardened control plane**: the CLI/MCP never touch sockets, keys, or state files directly; everything goes through a Unix-domain-socket RPC surface gated by filesystem permissions (see [docs/SECURITY.md][security]).
- **Fits production-minded apps**: the app still only exposes what you register; trust boundaries are pins + TLS, and production deployments can gate tools with policy and get every call audited (see [docs/ARCHITECTURE.md][architecture] §12).

## Key setup

For a **debug build** app, you can skip this entirely: the daemon auto-generates its own `key.pem` the first time it starts if one isn't already there (mode `0600`), and prints its `sha256/...` fingerprint on that first run. `cordierite link` (below) carries that fingerprint on the deep link itself for the app to pick up — see the app-side dev-mode flow in the root README and `docs/SECURITY.md`'s "Dev trust mode" section.

For a **release build** (or any build where you want a real embedded pin instead of trusting whatever link shows up), generate a daemon key explicitly with:

```bash
cordierite keygen
```

The command writes an unencrypted PEM private key (PKCS#8) to `<state-dir>/key.pem` by default (override with `--out`; add `--force` to overwrite) and prints the exact `sha256/...` SPKI fingerprint your app should place into `cliPins`. It runs non-interactively — safe to call from CI or a setup script.

## Commands

| Command | Role |
| --- | --- |
| `cordierite keygen [--out <path>] [--force]` | generate a daemon private key, print its app pin |
| `cordierite link [--ttl <s>] [--qr] [--open android\|ios-sim] [--scheme <s>]` | mint a pending session and print its deep link |
| `cordierite ls` | list sessions: alias, state, device, tool count |
| `cordierite tools [selector] [name] [--full]` | list a session's tools, or show one tool's full schema |
| `cordierite invoke [selector] <tool> --input '<json>' [--timeout <ms>]` | call a tool |
| `cordierite events [selector] [--follow]` | stream session/tool events; `--json` emits NDJSON |
| `cordierite revoke [selector]` | revoke a session |
| `cordierite daemon run\|start\|stop\|status` | daemon lifecycle |
| `cordierite mcp` | start a stdio MCP server proxying connected apps' tools to MCP clients |
| `cordierite doctor <artifact> [--assert-present\|--assert-absent]` | **release-gate step**: report or assert whether a built `.app`/`.ipa`/`.apk`/`.aab` contains Cordierite |

Every command that targets a session accepts an optional `selector` (a session id or an alias from `cordierite ls`); omit it when exactly one session is active. Global flags: `--json` (machine-readable output), `--no-color`, `--state-dir <path>` (default `~/.cordierite`). Run `cordierite <command> --help` for the exact flags of any command, or `cordierite --help` for the full list.

`cordierite link`'s deep link is `<scheme>:///?cordierite=<payload>&pin=<sha256/...>`: the `cordierite` param is the existing binary v2 bootstrap payload (address, session id, token, expiry — unchanged), and `pin` is a separate, out-of-band query param carrying the daemon's current SPKI fingerprint for apps that want to pick it up. An app build with embedded `cliPins` ignores `pin` outright — embedded pins always win. A debug build with no embedded pins trusts it for that session only (see `docs/SECURITY.md`'s "Dev trust mode" section); a release build with the module enabled never accepts it, embedded pins only.

## Daemon lifecycle

The daemon auto-starts the first time any CLI or MCP command needs it — you don't normally run `cordierite daemon start` yourself. It writes its state to `<state-dir>/` (`daemon.sock`, `daemon.pid`, `daemon.log`, `key.pem`, `config.json`, `audit/`), holds a single-instance lock via the pidfile, and keeps running independently of any one device's connection so a reload or crash on the device side never costs you the daemon process. Use `cordierite daemon status` to see what's running (version, pid, `wssPort`, pinned keys, live sessions, effective policy) and `cordierite daemon stop` to shut it down explicitly.

## MCP setup (Claude Code, Cursor, and similar)

Add `cordierite mcp` to the agent's MCP server config — no separate server process to manage; it auto-spawns the daemon the same way the CLI does:

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

Once configured, the connected app's tools appear as MCP tools automatically: `tools/list` mirrors the live registry (namespaced `<alias>__<name>` when more than one session is active), and `tools/call` proxies straight to the app with progress and errors preserved. Two built-in management tools let an agent bootstrap a session without shell access: `cordierite_connect` mints a link (optionally delivering it directly to a booted `android`/`ios-sim` target), and `cordierite_wait_for_session` waits for that session to be claimed.

## Release gate: `cordierite doctor`

Cordierite's inclusion in a build is controlled entirely by autolinking exclusion (see the root README and `docs/SECURITY.md`) — there is no runtime `debuggable` check to catch a pipeline that forgot to exclude the package. `cordierite doctor` is the replacement: an artifact-level assertion you run against the thing you're about to ship, not the config you think produced it.

```bash
cordierite doctor ./build/MyApp.ipa --assert-absent
cordierite doctor ./build/app-release.apk --assert-absent
```

It inspects a built `.app`/`.ipa`/`.apk`/`.aab` for Cordierite's native code (the `RCTNativeCordierite` Objective-C class and the plugin-authored `Info.plist` keys on iOS; the `com.callstackincubator.cordierite` dex package and `AndroidManifest.xml` meta-data keys on Android) and reports `present`/`absent` — or, with `--assert-present`/`--assert-absent`, exits non-zero when the artifact doesn't match what you expected:

| Exit code | Meaning |
| --- | --- |
| `0` | inspection succeeded; no assertion was given, or the assertion held |
| `3` | inspection succeeded, but `--assert-present`/`--assert-absent` did not hold |
| `64` | usage error (bad flags, or an artifact extension that isn't `.app`/`.ipa`/`.apk`/`.aab`) |
| `66` | the artifact could not be inspected — a required external tool (`unzip`) was missing, or the artifact was unreadable/corrupt. **Never treated as "absent"**: a broken check must fail loudly, not rubber-stamp a release. |

CI snippet, run against your production release build right before you ship it:

```yaml
- name: Assert Cordierite is excluded from the production build
  run: npx cordierite doctor ./build/app-release.apk --assert-absent
- name: Assert Cordierite is excluded from the production build (iOS)
  run: npx cordierite doctor ./build/MyApp.ipa --assert-absent
```

For an internally-distributed "testing" build that an agent drives, invert the assertion (`--assert-present`) so a forgotten inclusion — not just a forgotten exclusion — fails CI too.

**Known limitation:** the Android detection has two signals — the dex package name and the config plugin's `AndroidManifest.xml` meta-data keys — specifically so R8/ProGuard renaming the dex package alone doesn't flip a real inclusion to "absent". The manifest signal only exists if the Expo config plugin ran, though: a bare-RN app wired up via `react-native.config.js` with no keep rule for `com.callstackincubator.cordierite` and aggressive release minification can still evade both signals. `cordierite doctor` is strictly better than the runtime check it replaces, not a guarantee against every build configuration.

## Programmatic use

The package exports `runCli` and command handlers from [`src/index.ts`](src/index.ts) so you can embed the same behavior in Node or Bun scripts that need to drive Cordierite without shelling out.

## Related packages

- **[@cordierite/react-native](../react-native/README.md)** — native app client + Expo plugin.
- **[@cordierite/shared](../shared/README.md)** — wire protocol v2 types used by this package and the React Native client.

## Documentation

- [Architecture][architecture]
- [Wire protocol][protocol]
- [Security model & key rotation][security]
- [Monorepo README](../../README.md)

## Made with ❤️ at Callstack

`cordierite` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[cordierite-banner]: https://img.shields.io/badge/Cordierite-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/cordierite
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=cordierite&utm_term=readme-with-love
[architecture]: https://github.com/callstackincubator/cordierite/blob/main/docs/ARCHITECTURE.md
[protocol]: https://github.com/callstackincubator/cordierite/blob/main/docs/PROTOCOL.md
[security]: https://github.com/callstackincubator/cordierite/blob/main/docs/SECURITY.md
[license-badge]: https://img.shields.io/npm/l/cordierite?style=for-the-badge
[license]: https://github.com/callstackincubator/cordierite/blob/main/LICENSE
[npm-downloads-badge]: https://img.shields.io/npm/dm/cordierite?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/cordierite
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/cordierite/blob/main/CONTRIBUTING.md
[chat-badge]: https://img.shields.io/discord/426714625279524876.svg?style=for-the-badge
[chat]: https://discord.gg/xgGt7KAjxv
