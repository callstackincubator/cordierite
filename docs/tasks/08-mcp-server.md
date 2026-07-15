# 08 — MCP server (`cordierite mcp`)

## Goal

Expose connected apps' tools to MCP clients (Claude Code, Cursor, CI agents) via a
stdio MCP server that proxies the daemon RPC. This is the flagship agent surface
(ARCHITECTURE §9).

## Depends on

05 (RPC complete). 06 helps but only for shared client plumbing.

## Read first

- `docs/ARCHITECTURE.md` §9 (the spec), §5 (RPC + error types).
- `@modelcontextprotocol/sdk` docs (server, stdio transport, tool registration,
  `notifications/tools/list_changed`, progress notifications). Add it as a dependency
  of `packages/cordierite`. Fetch current docs before coding — the SDK API moves.

## Scope

New module tree `packages/cordierite/src/mcp/`:

1. **`cordierite mcp` command** — starts a stdio MCP server; connects to the daemon
   via `rpc/client.ts` (auto-spawn applies). All logging to **stderr** only (stdout is
   the MCP transport — never print to it).
2. **Tool listing** — build the MCP tool list from `sessions.list` + `tools.list`:
   - exactly one live session → tools under their own names;
   - multiple → `<alias>__<name>`;
   - descriptor `description` and `input_schema` map directly (`input_schema` absent →
     `{}` with `additionalProperties: true`); `annotations` map verbatim to MCP tool
     annotations.
   - Subscribe to daemon events (`events.subscribe`, kinds `tools_changed`,
     `session_claimed`, `session_revoked`, `session_expired`, `session_suspended`,
     `session_resumed`) and emit `notifications/tools/list_changed` when the effective
     tool list changes (including the single↔multi namespacing flip).
3. **Tool calls** — `tools/call` → RPC `tools.call` with the session selector implied
   by the namespacing; map `tool_call_progress` events for the in-flight call id to
   MCP progress notifications when the client sent a `progressToken`. Errors: return
   MCP tool-error content that includes the preserved `type` and message (do not
   throw protocol-level errors for tool failures).
4. **Management tool `cordierite_connect`** — MCP tool with input
   `{ target?: "android" | "ios-sim", ttlSeconds?: number }`:
   - no target → returns the deep link + a QR rendered as text (reuse
     `qr-terminal.ts`) for a human to scan;
   - with target → performs task-07's delivery and returns
     `{ sessionId, delivered: true }`. Requires task 07 to be merged; if it isn't
     yet, implement behind the same `open-target.ts` interface and let it error.
   - The result should tell the agent to poll/`wait`: also implement a companion tool
     `cordierite_wait_for_session` `{ sessionId, timeoutMs? }` that resolves when the
     session claims (subscribe to `session_claimed`) — this makes agent bootstrap
     fully autonomous.
5. **Session metadata** — expose `sessions.list` as an MCP resource
   (`cordierite://sessions`, JSON) so agents can inspect device state without a tool
   call.

## Out of scope

- HTTP/SSE MCP transport (stdio only in v2.0).
- Policy decisions (the daemon enforces them; MCP just surfaces `policy_denied`).

## Acceptance criteria

- Integration test: fake app client registers tools with schemas → MCP client (use
  the SDK's client over an in-process stdio pair) sees them in `tools/list` with
  schemas + annotations; `tools/call` round-trips; app `tool_error` types appear in
  the MCP error content; registering a second device flips names to
  `<alias>__<name>` and fires `list_changed`.
- `cordierite_connect` (no target) returns a decodable deep link;
  `cordierite_wait_for_session` resolves when a fake client claims.
- Nothing is ever written to stdout except MCP protocol frames (assert in test by
  capturing).
- `bun run lint/build/test` green.

## Testing

Use the real daemon + fake app-client harness from tasks 04–05, with the MCP SDK
client driving the server in-process. Snapshot the generated MCP tool list for one
scenario to lock the mapping.
