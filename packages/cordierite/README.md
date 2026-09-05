[![Cordierite][cordierite-banner]][repo]

### Drive app tools without shipping debug UI

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

The **`cordierite`** package is the operator/agent side of Cordierite: a long-lived **daemon** owning a TLS-terminated `wss://` listener and any number of device sessions, a **CLI** and an **MCP server** that are thin RPC clients of it, and the **key management** tying it together — so **developers, QA, and agents** steer app state from a terminal or an MCP client **instead of a hidden debug menu**.

## Why use this package

- **One daemon, many devices**: it auto-spawns on first use, serves every device on one `wss://` port, and survives Metro reloads, backgrounding, and network flaps by suspending and resuming sessions rather than dying with them.
- **Same surface for humans and agents**: the CLI (`tools`, `invoke`, `events`, ...) and `cordierite mcp` use the same RPC methods — an agent sees the tools a human operator does.
- **Hardened control plane**: the CLI/MCP never touch sockets, keys, or state files directly; everything goes through a Unix-domain-socket RPC surface gated by filesystem permissions ([docs/SECURITY.md][security]).
- **Fits production-minded apps**: the app only exposes what you register; trust boundaries are pins + TLS, and production deployments can gate tools with policy and audit every call ([docs/ARCHITECTURE.md][architecture] §12).

## Getting started

```bash
npm install cordierite
cordierite link --qr
```

Scan the QR (or open the deep link) in a Cordierite-enabled app, then:

```bash
cordierite tools
cordierite invoke sum --input '{"a":2,"b":3}'
```

That is the whole loop. There is no host process to start: `cordierite` auto-spawns its daemon the first time any command needs it.

## Commands

| Command | Role |
| --- | --- |
| `cordierite keygen [--out <path>] [--force]` | generate a daemon private key, print its app pin |
| `cordierite link [--ttl <s>] [--qr] [--open android\|ios-sim] [--scheme <s>]` | mint a pending session and print its deep link |
| `cordierite ls` | list sessions: alias, state, device, tool count |
| `cordierite tools [selector] [name] [--full]` | list a session's tools, or show one tool's full schema |
| `cordierite invoke [selector] <tool> --input '<json>' [--timeout <ms>]` | call a tool |
| `cordierite events [selector] [--follow] [--since <cursor>]` | stream session/tool events (default), or one-shot pull everything retained since `<cursor>` (`--since`); `--json` emits NDJSON |
| `cordierite revoke [selector]` | revoke a session |
| `cordierite daemon run\|start\|stop\|status` | daemon lifecycle |
| `cordierite mcp` | start a stdio MCP server proxying connected apps' tools to MCP clients |
| `cordierite doctor <artifact> [--assert-present\|--assert-absent]` | **release-gate step**: report or assert whether a built `.app`/`.ipa`/`.apk`/`.aab` contains Cordierite |

Every command that targets a session accepts an optional `selector` (a session id or an alias from `cordierite ls`); omit it when exactly one session is active. Global flags: `--json` (machine-readable output), `--no-color`, `--state-dir <path>` (default `~/.cordierite`). Run `cordierite <command> --help` for the exact flags of any command, or `cordierite --help` for the full list.

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

Once configured, the connected app's tools appear as MCP tools automatically: `tools/list` mirrors the live registry (namespaced `<alias>__<name>` when more than one session is active), and `tools/call` proxies straight to the app with progress and errors preserved.

Four built-in tools cover what an agent can't do through the app's own registry. `cordierite_connect` mints a link and, by default, delivers it to whichever `android`/`ios-sim` device it detects — pass `target`/`device` to choose, or `target: "none"` to force the human flow — falling back to a QR code, plus instructions to show it, only when there is nothing to deliver to. `cordierite_wait_for_session` then waits for that session to be claimed.

The other two give an agent a pull surface over `postEvent()`-pushed app events: `cordierite_events` drains everything retained since a cursor, and `cordierite_wait_for_event` blocks for a matching event (checking what's already retained before waiting live), rejecting with `tool_timeout` if none arrives in time.

## Test runners: `cordierite/client`

A thin typed wrapper over the same daemon RPC the CLI and MCP server use — for a Jest/Vitest/Detox spec that drives a running app without spawning `cordierite invoke ... --json` and parsing stdout:

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

`app.call`'s tool name and args/result types can't be inferred automatically — tools are registered by the connected app at runtime — so declare your own tool map once for typed calls throughout a suite:

```ts
type Tools = {
  sum: { args: { a: number; b: number }; result: { total: number } };
};

const app = await connect<Tools>();
const { total } = await app.call("sum", { a: 2, b: 3 }); // typed
```

`waitForEvent` first drains the daemon's per-session retained buffer for an already-arrived match before falling back to a live wait, so it's safe to call after the action that emits the event. Pass `since` (the `cursor` from a previous `app.events()`/`waitForEvent()` call) to skip events already handled:

```ts
const { events, cursor } = await app.events();               // pull: what already happened
const next = await app.waitForEvent("checkout_done", { since: cursor });
```

For everything else, the package exports `runCli` and the command handlers from [`src/index.ts`](src/index.ts), so you can embed the same behavior in Node or Bun scripts without shelling out.

## Keys and pins

You can skip this entirely while your app has no `cliPins` configured — the zero-config default, in **any** build type. The daemon auto-generates its own `key.pem` the first time it starts if one isn't already there (mode `0600`) and prints its `sha256/...` fingerprint on that first run; `cordierite link` carries that fingerprint on the deep link for the app to pick up. See [`docs/SECURITY.md`][security]'s "Trust modes" for what that does and does not protect.

For a build that should trust only a key you embedded ahead of time, generate one explicitly:

```bash
cordierite keygen
```

The command writes an unencrypted PEM private key (PKCS#8) to `<state-dir>/key.pem` by default (override with `--out`; add `--force` to overwrite) and prints the exact `sha256/...` SPKI fingerprint your app should place into `cliPins`. It runs non-interactively — safe to call from CI or a setup script.

`cordierite link`'s deep link is `<scheme>:///?cordierite=<payload>&pin=<sha256/...>`. The `cordierite` param is the existing binary v2 bootstrap payload (address, session id, token, expiry — unchanged); `pin` is a separate, out-of-band query param carrying the daemon's current SPKI fingerprint for apps that want to pick it up. An app build with embedded `cliPins` ignores `pin` outright — embedded pins always win, in every build type. A build with no embedded pins trusts it for that one session.

## Daemon lifecycle

The daemon auto-starts the first time any CLI or MCP command needs it — you don't normally run `cordierite daemon start` yourself. It writes state to `<state-dir>/` (`daemon.sock`, `daemon.pid`, `daemon.log`, `key.pem`, `config.json`, `audit/`), holds a single-instance lock via the pidfile, and runs independently of any one device's connection, so a reload or crash on the device side never costs you the daemon process.

Use `cordierite daemon status` to see what's running (version, pid, `wssPort`, pinned keys, live sessions, effective policy) and `cordierite daemon stop` to shut it down explicitly.

## Release gate: `cordierite doctor`

Cordierite's inclusion in a build is controlled entirely by autolinking exclusion (see [docs/BUILD-VARIANTS.md][build-variants]) — there is no runtime `debuggable` check to catch a pipeline that forgot to exclude the package. `doctor` is the replacement: an artifact-level assertion you run against the thing you're about to ship, not the config you think produced it.

```bash
cordierite doctor ./build/MyApp.ipa --assert-absent
cordierite doctor ./build/app-release.apk --assert-absent
```

Exit codes, what it inspects per platform, the Android marker-only detection rules and the CI wiring are in [docs/CI.md][ci].

## Related packages

- **[@cordierite/react-native](../react-native/README.md)** — native app client + Expo plugin.
- **[@cordierite/shared](../shared/README.md)** — wire protocol v2 types used by this package and the React Native client.

## Documentation

- [Architecture][architecture]
- [Wire protocol][protocol]
- [Security model & key rotation][security]
- [Build variants][build-variants]
- [CI and the release gate][ci]
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
[build-variants]: https://github.com/callstackincubator/cordierite/blob/main/docs/BUILD-VARIANTS.md
[ci]: https://github.com/callstackincubator/cordierite/blob/main/docs/CI.md
[license-badge]: https://img.shields.io/npm/l/cordierite?style=for-the-badge
[license]: https://github.com/callstackincubator/cordierite/blob/main/LICENSE
[npm-downloads-badge]: https://img.shields.io/npm/dm/cordierite?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/cordierite
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/cordierite/pulls
[chat-badge]: https://img.shields.io/discord/426714625279524876.svg?style=for-the-badge
[chat]: https://discord.gg/xgGt7KAjxv
