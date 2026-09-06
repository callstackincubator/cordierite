---
name: cordierite
description: Connect a Cordierite-enabled React Native app to your machine and drive it from the terminal (or MCP) using tools the app registers — useful for agents, scripts, and dev automation. Reach for this when the user mentions Cordierite, bootstrapping/pairing with the app, or invoking app-defined capabilities from the CLI or MCP.
---

# Cordierite

Cordierite is a CLI/daemon/MCP workflow for connecting to a Cordierite-enabled React
Native app, discovering its registered tools, invoking those tools, and ending the
session cleanly after use. A single `cordierite` daemon on this machine owns the
`wss://` listener and every device session; the CLI (and `cordierite mcp`, if this
agent is invoked as an MCP client instead of a shell) are both thin RPC clients of it and
auto-spawn it on first use — there is no separate "start the host" step to manage.

## Agent workflow (CLI)

1. Run **`cordierite ls --json`**. `data` is a list of sessions, each with `sessionId`,
   `alias`, `state`, `device`, `toolCount`. An empty list means no device has claimed a
   session yet — go to **Establish a session** below.
2. Every session-targeting command takes an optional **selector** (a session id or
   `alias` from step 1) as its first positional argument. **Omit it** when exactly one
   session is active — the CLI picks it automatically; pass it explicitly when several
   sessions exist (the CLI errors with `ambiguous_session` and lists the aliases if you
   don't).
3. **`cordierite tools [selector] --json`** — list tools registered in the app.
4. **`cordierite tools [selector] <tool-name> --full --json`** — inspect one tool's
   input/output schema before calling it.
5. **`cordierite invoke [selector] <tool-name> --input '{"key":"value"}' --json`** —
   invoke the tool with JSON args.
6. **`cordierite events [selector] --json`** — stream session/tool events (NDJSON) if you
   need to watch for `session_claimed`, `tools_changed`, or `app_event` without polling.

There is no `--session-id` flag in v2 — use the positional selector instead.

## Establish a session

If no session is active yet, mint a bootstrap link. **Run this from the app's root
directory and it needs no configuration at all** — the deep-link scheme is read from
`app.json`'s `expo.scheme`:

```bash
cordierite link --json
```

No key setup is needed either: the daemon generates its host key on first start.

Pass `--scheme myapp` only when the scheme cannot be discovered — you are not in the app
directory, or the project uses a dynamic `app.config.js` (which is never executed).
`CORDIERITE_SCHEME=myapp` does the same for a whole shell, and `cordierite init` records
it once in the project (see **Setup** below). Full order: `--scheme` → `CORDIERITE_SCHEME`
→ the nearest `.cordierite/config.json` walking up from the working directory → the state
dir's `config.json` → `<cwd>/app.json`. If none of them has one, the error names every
location it tried.

From `link`'s JSON output, use:

- **`data.deepLinkPayload`** to compose the full URL yourself, or just print/relay
  **`data`**'s rendered deep link (`<scheme>:///?cordierite=<deepLinkPayload>&pin=<sha256/...>`)
  for a human to open, or scan the QR from `cordierite link --scheme myapp --qr` on a TTY.
  Relay the rendered link whole — the `pin` param is what lets a debug build with no embedded
  pins trust the daemon, and anything re-parsing the payload must stop at the `&`.
- **`data.sessionId`** — the selector to poll with in the next step.

For a simulator/emulator you control directly, skip the deep link entirely:

```bash
cordierite link --open ios-sim     # or: --open android
```

With more than one simulator booted (or several devices attached) this errors and lists
them rather than picking one — re-run with `--device <udid|serial>`.

A paired **physical iPhone/iPad** has an experimental path of its own, never auto-detected
and always opt-in:

```bash
cordierite link --scheme myapp --open ios-device --bundle-id com.example.myapp
```

It goes through `xcrun devicectl`, so it needs iOS 17+, Xcode 15+, the device paired,
trusted and **connected** with Developer Mode on, a dev-signed build already installed, and
the phone on the same network as this machine (the address is on `link`'s `Endpoint` line).
If the app is already running and the link does not take, add `--relaunch` (it terminates the
running instance first). If it still fails, fall back to the QR flow above — that is still the
only option on iOS 16 and below.

Then poll (or use `cordierite events <sessionId> --json` to avoid polling) until the
session shows `state: "active"` in `cordierite ls --json` or
`cordierite tools <sessionId>` stops erroring.

## Establish a session (MCP)

If this agent is talking to Cordierite over MCP instead of a shell, use the built-in
management tools instead of the CLI commands above.

**Call `cordierite_connect` with no arguments.** It auto-detects a booted iOS simulator or
attached Android device and delivers the link straight to it — no human involved. A result
with `delivered: true` is done; go on to `cordierite_wait_for_session({ sessionId })`,
which blocks until the device connects (or returns immediately if it already has). After
that the app's own tools appear directly in `tools/list` — call them with `tools/call`
like any other MCP tool.

Pass `target: "android"` / `"ios-sim"` (plus `device` — an adb serial or simulator udid) only
to override that choice, e.g. when several devices are up and the result said so.

`target: "ios-device"` reaches a paired **physical** iPhone/iPad and additionally needs
`bundleId` (or `iosBundleId` in `config.json`); add `relaunch: true` if the app is already
running and the link does not take. It is experimental and is never picked automatically — a
paired iPhone may be someone's personal phone — so ask for it by name only when the user has
said that is where the app is running, and expect the same prerequisites as the CLI flag above.

**If the result has a `qr` field instead of `delivered: true`, nothing was delivered and a
human has to act.** Do not call `cordierite_wait_for_session` yet — it produces no output
while it waits, so calling it first looks like a hang and burns its whole timeout. Show the
user the `qr` value verbatim in a fenced code block, show `deepLink` under it, and ask them
to scan. The result's `instructions` field says exactly this; follow it. Read `note` to see
why delivery didn't happen — usually no device is booted, or several are and you should
re-call with an explicit `target`.

## Terminate the connection

**`cordierite revoke [selector]`** ends one session (closes its socket, frees its
alias) without touching the daemon or any other session. There is normally no reason to
stop the daemon itself — `cordierite daemon stop` only if you specifically need to free
the `wss://` port or the daemon's key is being rotated.

## Declaring tools

The app must register tools before `cordierite tools` / `cordierite invoke` (or MCP
`tools/call`) can do anything useful. Register with `registerTool` or `useCordieriteTool`:

```ts
import { registerTool } from "@cordierite/react-native";
import { z } from "zod";

const echoInput = z.object({ value: z.unknown() });
const echoOutput = z.object({ echoed: z.unknown() });

registerTool({
  name: "echo",
  description: "Return the input unchanged",
  inputSchema: echoInput,
  outputSchema: echoOutput,
  handler: async (args) => ({ echoed: args.value }),
});
```

`inputSchema`/`outputSchema` accept three forms:

| Form | Validated app-side | Shape agents see |
| --- | --- | --- |
| Standard Schema with a JSON Schema exporter (**Zod v4**, arktype) | yes | its exporter's output |
| `{ schema, jsonSchema }` pair — for Zod 3 (`zod-to-json-schema`), valibot (`@valibot/to-json-schema`) | yes | the supplied JSON Schema |
| A raw JSON Schema object (no `~standard`, at least one JSON Schema keyword) | **no** — args pass through | the object, verbatim |

A bare Zod 3 / plain valibot schema (Standard Schema, no exporter) **throws in `__DEV__`**:
it would otherwise register a shapeless tool that `tools/list` reports as taking any
object. Pair it, or pass raw JSON Schema.

An input schema must be **object-typed at its root** to be callable over MCP: a root
`enum`, `const`, `$ref` or `anyOf` is legal JSON Schema but gives the agent no named
arguments to pass (issue #34).

## Notes

- Use **`--json`** for structured CLI output in agent flows; runtime failures in
  `--json` mode are JSON on stderr, not bare text.
- `cordierite init`, run once in an app root, records the scheme in
  `.cordierite/config.json` and prints the MCP server entry to paste. Re-running it is
  always safe (it keeps the recorded scheme; `--force` re-adopts `app.json`'s), it never
  generates keys, and it never touches daemon state.
- `cordierite keygen` is only for **hardening** (rotating the host key, or provisioning
  one in CI ahead of a release build) — the daemon auto-generates a key on first start,
  so a normal dev loop never needs it. It is non-interactive when given `--out`.
- Selectors (session id or alias), not `--session-id`, target a specific session; omit
  the selector when only one session is live.
- If `cordierite ls` is empty or `tools`/`invoke` fail with `no_session` or
  `unknown_session`, establish a session first (see above).
- If the app registers no tools, `cordierite tools` returns an empty list — that's not an
  error.
- The daemon serves **every** connected device on one process; there's no need to run
  more than one `cordierite` daemon, and no `--port` flag to juggle between devices —
  use the selector instead.
- A denied call (production policy set to `"deny"` for that tool/class) surfaces as
  `policy_denied`, not a generic failure — if you see that error type, the fix is a
  policy/config change, not a retry.

## Setup

For project integration guidance, see [setup.md](./references/setup.md).
