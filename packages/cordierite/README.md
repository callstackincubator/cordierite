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
| `cordierite invoke [selector] <tool> --input '<json>' [--timeout <ms>]` | call a tool. `--timeout` (clamped to 1 000–600 000 ms) can **shorten** the deadline but cannot extend it past the app's own timer: the app aborts the handler at the tool's declared `timeoutMs`, or 10 s for a tool that declares none, whatever the caller asks for. Give a slow tool more room by declaring `timeoutMs` on its registration |
| `cordierite events [selector] [--follow] [--since <cursor>]` | stream session/tool events (default), or one-shot pull everything retained since `<cursor>` (`--since`); `--json` emits NDJSON |
| `cordierite revoke [selector]` | revoke a session |
| `cordierite daemon run\|start\|stop\|status` | daemon lifecycle |
| `cordierite mcp` | start a stdio MCP server proxying connected apps' tools to MCP clients |
| `cordierite doctor <artifact> [--assert-present\|--assert-absent]` | **release-gate step**: report or assert whether a built `.app`/`.ipa`/`.apk`/`.aab` contains Cordierite |

Every command that targets a session accepts an optional `selector` (a session id or an alias from `cordierite ls`); omit it when exactly one session is active. Global flags: `--json` (machine-readable output), `--no-color`, `--state-dir <path>` (default `~/.cordierite`), `--daemon-restart` (on a daemon/CLI version mismatch, restart the daemon even though that drops live sessions and unclaimed links; `CORDIERITE_DAEMON_RESTART=1` and `config.json`'s `restartDaemonOnVersionMismatch` do the same for every command, and `--no-daemon-restart` overrules both for one). Run `cordierite <command> --help` for the exact flags of any command, or `cordierite --help` for the full list.

`cordierite link`'s deep link is `<scheme>:///?cordierite=<payload>&pin=<sha256/...>`: the `cordierite` param is the existing binary v2 bootstrap payload (address, session id, token, expiry — unchanged), and `pin` is a separate, out-of-band query param carrying the daemon's current SPKI fingerprint for apps that want to pick it up. An app build with embedded `cliPins` ignores `pin` outright — embedded pins always win. A debug build with no embedded pins trusts it for that session only (see `docs/SECURITY.md`'s "Dev trust mode" section); a release build with the module enabled never accepts it, embedded pins only.

## Daemon lifecycle

The daemon auto-starts the first time any CLI or MCP command needs it — you don't normally run `cordierite daemon start` yourself. It writes its state to `<state-dir>/` (`daemon.sock`, `daemon.pid`, `daemon.log`, `daemon.log.1`, `key.pem`, `config.json`, `audit/`), holds a single-instance lock via the pidfile, and keeps running independently of any one device's connection so a reload or crash on the device side never costs you the daemon process. Use `cordierite daemon status` to see what's running (version, pid, `wssPort`, pinned keys, live sessions, effective policy, and the audit log's retention window, file count, size, and failure counters) and `cordierite daemon stop` to shut it down explicitly. Because it outlives the CLI that started it, upgrading Cordierite would otherwise leave the old daemon serving your commands: the first command of every CLI/MCP process compares its version with the daemon's and replaces a stale daemon when no sessions are connected. When there is live state to lose — connected sessions, or an unexpired link nobody has scanned yet — the command stops instead, naming both versions and what would go, until you run `cordierite daemon stop` or pass `--daemon-restart`. A daemon *newer* than your CLI is left alone with a warning, so a project-local install never downgrades a global one's daemon.

Neither log grows without bound: `audit/<YYYY-MM-DD>.jsonl` files older than `auditRetentionDays` (default 30) are pruned when the daemon starts and once a day after, and a `daemon.log` over `daemonLogMaxBytes` (default 10 MiB) is rotated to `daemon.log.1` when a daemon is next spawned. Both are `config.json` keys — see `docs/ARCHITECTURE.md` §3.

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

Once configured, the connected app's tools appear as MCP tools automatically: `tools/list` mirrors the live registry (namespaced `<alias>__<name>` when more than one session is active), and `tools/call` proxies straight to the app with progress and errors preserved. Two built-in management tools let an agent bootstrap a session without shell access: `cordierite_connect` mints a link and, by default, delivers it to whichever `android`/`ios-sim` device it detects (pass `target`/`device` to choose, or `target: "none"` to force the human flow) — falling back to a QR code, plus instructions to show it, only when there is nothing to deliver to; and `cordierite_wait_for_session` waits for that session to be claimed. Two more built-in tools give an agent a pull surface over `postEvent()`-pushed app events: `cordierite_events` drains everything retained since a cursor, and `cordierite_wait_for_event` blocks for a matching event (checking what's already retained before waiting live), rejecting with `tool_timeout` if none arrives in time.

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

**Android detection** has three signals, in order of reliability:

1. `CordieriteNativeMarker`, kept unminified by the keep rule `@cordierite/react-native` ships via `consumerProguardFiles`. It reaches every consuming app's R8 run without the app authoring any rule, so it holds for bare-RN apps that never touch the Expo config plugin.
2. The dex package name — survives ordinary minification but not R8 full mode's repackaging.
3. The config plugin's `AndroidManifest.xml` meta-data keys — only present if the plugin ran.

Signals 2 and 3 are retained as fallbacks for artifacts built before the marker existed.

**Verified** against a real R8-minified release APK (`assembleRelease -Pandroid.enableMinifyInReleaseBuilds=true`): the R8 mapping shows sibling classes obfuscated (`CordieriteBuildConfig -> …cordierite.a`) while `CordieriteNativeMarker` keeps its fully-qualified name, and `doctor --assert-present` passes on that artifact.

**Still not covered:** R8 *full mode* with `-repackageclasses` was not exercised, and no artifact was tested from a bare-RN app that uses neither Expo nor the config plugin — the configuration the marker most directly targets. The marker should hold in both (a `-keep` rule prevents renaming and removal regardless of mode), but that is reasoning, not a measurement.

## Programmatic use

### Test runners: `cordierite/client`

A thin typed wrapper over the same daemon RPC the CLI and MCP server use — for a Jest/Vitest/Detox spec that wants to drive a running app without spawning `cordierite invoke ... --json` and parsing stdout:

```ts
import { connect } from "cordierite/client";

// auto-spawns the daemon and picks the single session, or pass { selector: "pixel-8" } to target one explicitly
const app = await connect();

await app.tools();                                  // ToolDescriptor[]
const { total } = await app.call("sum", { a: 2, b: 3 });
const { payload } = await app.waitForEvent("checkout_done", { timeoutMs: 5_000 });
app.close();
```

Errors surface as a `CordieriteError` whose `type` preserves the daemon's wire error type verbatim, so a test can assert on it directly instead of string-matching stderr:

```ts
await expect(app.call("checkout", {})).rejects.toMatchObject({ type: "policy_denied" });
```

Pair a simulator/emulator in a `globalSetup` without shelling out via `link`/`waitForSession`:

```ts
import { link, waitForSession } from "cordierite/client";

const { sessionId } = await link({ target: "ios-sim" });
const app = await waitForSession(sessionId, { timeoutMs: 60_000 });
```

`app.call`'s tool name and args/result types can't be inferred automatically (tools are registered by the connected app at runtime) — declare your own tool map once for typed calls throughout a suite:

```ts
type Tools = {
  sum: { args: { a: number; b: number }; result: { total: number } };
};

const app = await connect<Tools>();
const { total } = await app.call("sum", { a: 2, b: 3 }); // typed
```

`waitForEvent` first drains the daemon's per-session retained buffer for an already-arrived match before falling back to a live wait, so it's safe to call after the action that emits the event too — no need to call it first. Pass `since` (the `cursor` from a previous `app.events()`/`waitForEvent()` call) to skip events already handled and wait only for a new one:

```ts
const { events, cursor } = await app.events();               // pull: what already happened
const next = await app.waitForEvent("checkout_done", { since: cursor });
```

### Everything else: `runCli`

The package also exports `runCli` and command handlers from [`src/index.ts`](src/index.ts) so you can embed the same behavior in Node or Bun scripts that need to drive Cordierite without shelling out.

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
