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

If no session is active yet, mint a bootstrap link. Requires a deep-link scheme; pass
`--scheme` or make sure `~/.cordierite/config.json` already has one set:

```bash
cordierite link --scheme myapp --json
```

If the project has no daemon key yet, generate one first — this is non-interactive and
safe to run from an agent or script:

```bash
cordierite keygen --out ~/.cordierite/key.pem
```

Add the printed `sha256/...` fingerprint to the app's `cliPins` (see **Setup** below if
you are wiring Cordierite into an app for the first time — that step needs a native
rebuild, so it isn't a fast in-session action).

From `link`'s JSON output, use:

- **`data.deepLinkPayload`** to compose the full URL yourself, or just print/relay
  **`data`**'s rendered deep link (`<scheme>:///?cordierite=<deepLinkPayload>`) for a
  human to open, or scan the QR from `cordierite link --scheme myapp --qr` on a TTY.
- **`data.sessionId`** — the selector to poll with in the next step.

For a simulator/emulator you control directly, skip the deep link entirely:

```bash
cordierite link --scheme myapp --open ios-sim     # or: --open android
```

Then poll (or use `cordierite events <sessionId> --json` to avoid polling) until the
session shows `state: "active"` in `cordierite ls --json` or
`cordierite tools <sessionId>` stops erroring.

## Establish a session (MCP)

If this agent is talking to Cordierite over MCP instead of a shell, use the built-in
management tools instead of the CLI commands above: `cordierite_connect` (optionally with
`target: "android"` or `"ios-sim"`) mints and, for a target, delivers the link without any
shell access; `cordierite_wait_for_session({ sessionId })` blocks until that session is
claimed (or returns immediately if it already was). After that, the app's own tools
appear directly in `tools/list` — call them with `tools/call` like any other MCP tool.

## Terminate the connection

**`cordierite revoke [selector]`** ends one session (closes its socket, frees its
alias) without touching the daemon or any other session. There is normally no reason to
stop the daemon itself — `cordierite daemon stop` only if you specifically need to free
the `wss://` port or the daemon's key is being rotated.

## Declaring tools

The app must register tools before `cordierite tools` / `cordierite invoke` (or MCP
`tools/call`) can do anything useful. Define schemas with **Zod v4** (its built-in JSON
Schema exporter means agents see a real tool shape) and register with `registerTool` or
`useCordieriteTool`:

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

## Notes

- Use **`--json`** for structured CLI output in agent flows; runtime failures in
  `--json` mode are JSON on stderr, not bare text.
- `cordierite keygen` is non-interactive when given `--out`; safe to run unattended.
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
