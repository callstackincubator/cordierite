# Cordierite Architecture

This is the canonical architecture reference for the current Cordierite implementation.
It describes the daemon-based v2 protocol and public surfaces. For field-level wire
details, see [PROTOCOL.md](PROTOCOL.md); for operational security guidance, see
[SECURITY.md](SECURITY.md).

## 1. Goals

1. **Survive churn.** Metro reloads, backgrounding, and network flaps must not require
   operator intervention (no new host process or deep link for a reconnect within the
   grace window while the native app process remains alive). App process death requires
   a fresh bootstrap because resume credentials are never persisted to disk.
2. **Agent-native.** MCP is the primary machine-consumption surface; the CLI is the
   human surface. Both are thin clients of the same daemon RPC.
3. **Multi-device.** One daemon serves N concurrent device sessions on one port.
4. **Hardened local control plane.** Unix-domain-socket RPC guarded by filesystem
   permissions replaces the unauthenticated localhost TCP API.
5. **Dev-first, production-capable.** Same protocol everywhere; production adds policy
   (consent, audit) and a compile-out story, not a different architecture.

## 2. Topology

```
                        operator machine                                devices
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  cordierite CLI ──┐                                      │
│  (thin client)    │                                      │
│                   │  UDS: <state-dir>/daemon.sock        │    pinned wss:// :8443
│  MCP clients ─────┼──────► cordierite daemon ◄───────────┼──────── iPhone (session A)
│  (Claude Code,    │        │  key + TLS listener         │◄─────── Pixel  (session B)
│   Cursor, CI) ────┘        │  session manager            │◄─────── iOS sim (session C,
│                            │  link minter                │          via localhost)
│                            │  event bus                  │
│                            │  MCP server (stdio proxy)   │
│                            │  policy + audit             │
│                            └── state: <state-dir>/       │
└──────────────────────────────────────────────────────────┘
```

- One daemon per operator machine (per user). It is long-lived and never exits because
  of anything a device does.
- Devices connect **to** the daemon over pinned `wss://` (same direction as v1 — this is
  what works for physical phones).
- The CLI and MCP server never touch sockets, keys, or state files directly; everything
  goes through the daemon RPC.

## 3. State directory

Default `~/.cordierite/`, overridable with `CORDIERITE_STATE_DIR` (tests rely on the
override). Created lazily with mode `0700`. Layout:

| Path | Purpose | Mode |
| --- | --- | --- |
| `daemon.sock` | UDS control socket | `0600` |
| `daemon.pid` | pidfile (single-instance lock) | `0600` |
| `daemon.log` | daemon stdout/stderr when auto-spawned | `0600` |
| `key.pem` | default host private key (`cordierite keygen` default output) | `0600` |
| `config.json` | daemon configuration (port, grace, policy) | `0600` |
| `audit/<YYYY-MM-DD>.jsonl` | append-only audit log | `0600` |

The daemon refuses to load a key file that is group/world-readable.

`config.json` shape (all fields optional, defaults shown):

```json
{
  "wssPort": 8443,
  "keyPath": "<state-dir>/key.pem",
  "graceSeconds": 600,
  "linkTtlSeconds": 300,
  "keepaliveIntervalSeconds": 15,
  "policy": { "default": "allow", "destructive": "allow" },
  "advertisedIp": null,
  "scheme": null
}
```

`advertisedIp` overrides auto-detection of the address advertised in minted bootstrap
payloads. `scheme` is the deep-link URI scheme composed into `cordierite link`'s output
when `--scheme` is not passed (§10) — set it once here instead of on every invocation.

## 4. Daemon lifecycle

- `cordierite daemon run` — run in the foreground (what auto-spawn executes, and what
  systemd/launchd would use).
- `cordierite daemon start|stop|status` — explicit control. `start` spawns `daemon run`
  detached with stdio redirected to `daemon.log`; `stop` sends `daemon.shutdown` over
  RPC (SIGTERM fallback via pidfile); `status` renders `daemon.status`.
- **Auto-spawn:** the shared RPC client library used by every CLI command attempts to
  connect to `daemon.sock`. On `ENOENT`/`ECONNREFUSED` it (1) takes an exclusive
  spawn-lock file to prevent double-spawn races, (2) spawns `daemon run` detached,
  (3) polls the socket until ready (timeout 5 s), (4) retries the original request.
  A stale socket file with a dead pid is unlinked before spawning.
- Single instance is enforced via the pidfile (write with `O_EXCL`; on conflict, check
  liveness with `process.kill(pid, 0)` and take over only if dead).
- SIGINT/SIGTERM: close all device sockets with code 1001, remove `daemon.sock` and
  `daemon.pid`, flush audit, exit 0.

## 5. Control plane RPC (UDS)

**Framing:** newline-delimited JSON (one JSON-RPC 2.0 message per line) over the UDS.
Server→client **notifications** (method `event`) are pushed on any connection with an
active `events.subscribe`.

**Session selectors:** methods that operate on a session take `selector?: string`
matching a session id or an alias. When omitted: if exactly one session is in state
`active` or `suspended`, use it; if zero, error `no_session`; if several, error
`ambiguous_session` (message lists aliases).

**Aliases** are derived at claim time from device metadata: slugified
`device_model` (lowercase, non-alphanumeric → `-`), deduplicated with `-2`, `-3`
suffixes. Fallback slug: `device`.

Methods:

| Method | Params | Result |
| --- | --- | --- |
| `daemon.status` | — | `{ version, pid, startedAt, wssPort, pinnedKeys: [spkiPin], sessions: SessionSummary[] }` |
| `daemon.shutdown` | — | `{ ok: true }` (then exits) |
| `link.create` | `{ ttlSeconds?, addressOverride? }` | `{ sessionId, deepLinkPayload, endpoint: { family, address, port }, expiresAt }` — `deepLinkPayload` is the base64url bootstrap blob; callers compose `<scheme>:///?cordierite=<payload>`. `addressOverride` forces the advertised address (the emulator/simulator fast path uses it to force `127.0.0.1`). |
| `sessions.list` | — | `SessionSummary[]` |
| `sessions.describe` | `{ selector? }` | full session detail incl. device metadata, state timestamps, tool count |
| `sessions.revoke` | `{ selector? }` | `{ ok: true }` — closes socket (code 1000), frees alias |
| `tools.list` | `{ selector? }` | `ToolDescriptor[]` (full schemas + annotations) |
| `tools.call` | `{ selector?, name, args, timeoutMs? }` | `{ result, callId }` on success — `callId` lets a caller with several in-flight calls match `tool_call_progress`/`tool_call_finished` events back to this call; JSON-RPC error with `data.type` preserving the wire error type on failure |
| `events.subscribe` | `{ sessionSelector?, kinds? }` | `{ ok: true }`, then `event` notifications on this connection |

`SessionSummary`: `{ sessionId, alias, state, device: { manufacturer?, model?, os? },
createdAt, claimedAt?, suspendedAt?, toolCount }`.

`daemon.status`'s result also reports the effective policy config and audit surfacing:
`{ ..., policy: { default, destructive, tools? }, audit: { path, failedWrites } }` (§12).

Event notification payload: `{ kind, sessionId?, alias?, ts, data }` where `kind` is one
of `daemon_started`, `link_created`, `link_expired`, `session_claimed`,
`session_suspended`, `session_resumed`, `session_revoked`, `session_expired`,
`tools_changed`, `app_event`, `tool_call_started`, `tool_call_progress`,
`tool_call_finished`.

**Error codes** (JSON-RPC `error.data.type`): `no_session`, `ambiguous_session`,
`unknown_session`, `session_not_active`, `tool_not_found`,
`tool_input_validation_error`, `tool_output_validation_error`, `tool_execution_error`,
`tool_serialization_error`, `tool_timeout`, `session_suspended`, `policy_denied`,
`invalid_request`. App-side error types must be preserved **verbatim** end-to-end
(daemon → RPC → CLI/MCP output); never re-wrap them under a generic type.

## 6. Session state machine

```
                link.create
                    │
                    ▼
 ┌─► PENDING ──ttl expired──► DISCARDED            (link-level; cheap, re-issuable)
 │      │
 │   claim ok (wss + token)
 │      ▼
 │   ACTIVE ◄────────────resume ok───────┐
 │      │                                │
 │   socket lost                         │
 │      ▼                                │
 │   SUSPENDED ──grace elapsed──► EXPIRED│
 │      └────────────────────────────────┘
 └─ sessions.revoke from any state ──► REVOKED
```

Rules:

- `PENDING` sessions hold `{ sessionId (12 random bytes, base64url), token (32 random
  bytes), expiresAt }`. Tokens are compared with `crypto.timingSafeEqual` and are
  single-use: consumed on successful claim, and **also invalidated after 5 failed claim
  attempts** for that session id.
- On claim the daemon issues a `resume_token` (32 random bytes) in the ack. On every
  successful resume the resume token is **rotated** (old one invalid immediately).
- `ACTIVE → SUSPENDED` (socket close/error/heartbeat loss): the tool registry, device
  metadata, and alias are retained. Pending tool calls fail fast with `session_suspended`.
- `SUSPENDED → ACTIVE` via `session_resume` on a fresh pinned socket within
  `graceSeconds`. After resume the app re-sends a full `tool_registry_snapshot`
  (authoritative; replaces the retained registry).
- Session ids and aliases never collide across live sessions. Terminal states
  (`DISCARDED`, `EXPIRED`, `REVOKED`) free the alias.
- There is **no limit** on concurrent sessions; all share the single wss listener.

## 7. Wire protocol v2 (app ↔ daemon, over pinned wss)

Text frames only; binary frames → close 1003. Max payload 256 KiB both directions
(`ws` server `maxPayload`; clients enforce before send). Malformed JSON → close 1008
reason `invalid_json`. Unknown message `type` after claim → close 1008 reason
`unknown_message_type` (strict, not lenient). Every post-claim message must carry the
active `session_id`; mismatch → close 1008 reason `session_mismatch`.

Unclaimed connections are dropped after 10 s (`pre_claim_timeout`). A connection's
first message must be `session_claim` or `session_resume`.

**Keepalive** is WebSocket protocol-level, not JSON: the daemon pings every
`keepaliveIntervalSeconds`; two missed pongs → treat as socket loss (suspend). Clients
(OkHttp `pingInterval`, URLSession `sendPing`) ping on the same interval and surface
missed pongs as connection errors so the app SDK can reconnect.

Messages:

```jsonc
// app → daemon, first message on a fresh socket
{ "type": "session_claim", "protocol_version": 2, "session_id": "…", "token": "<base64url 32B>",
  "device_manufacturer?": "…", "device_model?": "…", "device_os?": "…" }   // strings ≤256 chars

// app → daemon, first message when resuming
{ "type": "session_resume", "protocol_version": 2, "session_id": "…", "resume_token": "<base64url 32B>" }

// daemon → app, success for both claim and resume (resume_token is rotated each time)
{ "type": "session_ack", "session_id": "…", "status": "ok", "alias": "pixel-8",
  "resume_token": "<base64url 32B>", "keepalive_interval_s": 15, "grace_s": 600 }

// app → daemon
{ "type": "tool_registry_snapshot", "session_id": "…", "tools": [ToolDescriptor] }
{ "type": "tool_registry_delta", "session_id": "…", "operation": "upsert", "tool": ToolDescriptor }
{ "type": "tool_registry_delta", "session_id": "…", "operation": "remove", "name": "…" }
{ "type": "tool_result", "session_id": "…", "id": "call_…", "result": <json> }
{ "type": "tool_error", "session_id": "…", "id": "call_…",
  "error": { "type": "<one of §5 tool_* types>", "message": "…", "details?": <json> } }
{ "type": "tool_call_progress", "session_id": "…", "id": "call_…", "progress?": 0.5, "message?": "…" }
{ "type": "event", "session_id": "…", "name": "…", "payload?": <json>, "ts": <unix ms> }

// daemon → app
{ "type": "tool_call", "session_id": "…", "id": "call_…", "name": "…", "args": <json object> }
```

`ToolDescriptor`:

```jsonc
{ "name": "…",                       // required, unique per session, [a-zA-Z0-9_-]{1,64}
  "description": "…",                // required
  "input_schema?": <json-schema>,    // draft 2020-12, from Standard Schema exporter
  "output_schema?": <json-schema>,
  "annotations?": { "readOnlyHint?": bool, "destructiveHint?": bool, "idempotentHint?": bool } }
```

Snapshot/delta validation is strict on the daemon side: every element must be a valid
`ToolDescriptor` (name pattern enforced); an invalid snapshot → close 1008 reason
`invalid_registry`. Never index into unvalidated data.

## 8. Bootstrap payload v2

Deep link format unchanged: `<scheme>:///?cordierite=<base64url-no-padding>`.

Binary layout (all integers big-endian):

| Bytes | Field |
| --- | --- |
| 1 | version, `0x02` |
| 1 | address family: `0x04` (IPv4) or `0x06` (IPv6) |
| 4 or 16 | address |
| 2 | port |
| 1 + n | sessionId length (UTF-8) + bytes |
| 32 | token |
| 8 | expiresAt, unix **seconds** |

v1 (`0x01`) payloads are rejected by v2 clients. `formatAgentWebSocketUrl` must bracket
IPv6 literals (`wss://[fd00::1]:8443`).

Delivery paths, by preference:

1. **Emulator/simulator fast path (no deep link UX):** `cordierite link --open android`
   runs `adb reverse tcp:<wssPort> tcp:<wssPort>` and fires the deep link via
   `adb shell am start -a android.intent.action.VIEW -d '<link>'` with the advertised
   address forced to `127.0.0.1`; `--open ios-sim` uses `xcrun simctl openurl booted
   '<link>'`. Fully scriptable — this is the CI/agent path.
2. **Physical device on LAN:** printed deep link + QR (as v1).
3. **Remote/production:** the same deep link delivered out-of-band; policy + audit apply.

## 9. MCP server

`cordierite mcp` starts a **stdio** MCP server (SDK: `@modelcontextprotocol/sdk`) that
proxies daemon RPC (auto-spawning the daemon like any client):

- `tools/list`: live registry. Exactly one session → tools exposed under their own
  names; multiple sessions → namespaced `<alias>__<name>`. Registry/session changes
  emit `notifications/tools/list_changed`.
- `tools/call` → `tools.call`; `tool_call_progress` frames map to MCP progress
  notifications. Errors surface as MCP tool errors carrying the preserved `type`.
- Descriptor `annotations` map to MCP tool annotations verbatim.
- Two built-in management tools. `cordierite_connect` mints a link (`link.create`) and,
  when a target argument is given (`android` / `ios-sim`), delivers it via the fast
  path; returns the deep link + QR text otherwise. `cordierite_wait_for_session` then
  blocks (up to a `timeoutMs`) until that session is claimed, or resolves immediately if
  it already has been. Together these let an agent bootstrap a device session and know
  when it's ready without shell access.

## 10. CLI surface

Thin renderer over the RPC. Global flags: `--json` (machine output; NDJSON for
streams), `--no-color`, and `--state-dir`.

| Command | Behavior |
| --- | --- |
| `cordierite keygen [--out <path>] [--force]` | non-interactive with `--out`; default writes `<state-dir>/key.pem`; prints `sha256/…` pin |
| `cordierite link [--ttl <s>] [--qr] [--open android\|ios-sim] [--device <serial>] [--scheme <s>]` | mint a pending session, print its deep link, QR code, or deliver it to an emulator/simulator; `--device` applies only to `--open android` |
| `cordierite ls` | sessions with alias, state, device, tool count |
| `cordierite tools [selector] [name] [--full]` | list tools, or show one tool's schemas and annotations |
| `cordierite invoke [selector] <tool> --input '<json>' [--timeout <ms>]` | call a tool |
| `cordierite events [--follow] [selector]` | subscribe to the event bus; `--json` → NDJSON |
| `cordierite revoke [selector]` | revoke a session |
| `cordierite daemon run\|start\|stop\|status` | lifecycle (§4) |

The `--scheme` needed to compose the deep link is taken from the flag, else
`config.json`, else the CLI errors with a clear message.

## 11. React Native SDK

Package `@cordierite/react-native`. Entry points:

- `@cordierite/react-native` — **side-effect-free**. Its default API includes
  `registerTool`, `useCordieriteTool`, `postEvent`, `getRegisteredTools`,
  `installCordieriteDeepLinkBootstrap(options?)`, `addCordieriteListener`,
  `getCordieriteState`, and `connect`; it also exports `cordieriteClient`, parsing
  helpers, and types for advanced integrations. TurboModule lookup is lazy (first
  native call), never at import time.
- `@cordierite/react-native/auto` — side-effect entry: installs the deep-link bootstrap
  with defaults and starts native-lease recovery on import (the v1 root-import behavior,
  now opt-in).
- `@cordierite/react-native/noop` — identical public API, inert implementation, for
  release-build compile-out via Metro `resolveRequest` or conditional require. Document
  the recipe in the package README.

Client behavior:

- On every successful claim/resume, native commits the latest `resume_token` lease before
  emitting the `session_ack` to JS. The lease is synchronous, native **process-memory
  only**, and never written to disk. It records transport suspension/disconnection time,
  which anchors `grace_s`; ack time does not. On socket loss, auto-reconnect with
  exponential backoff (0.5 s → 30 s cap, jitter) while the lease remains within grace,
  and re-send the full registry snapshot after every successful resume. Resume attempts
  pause in background and restart on foreground.
- Installing the bootstrap explicitly or importing `/auto` registers the runtime URL
  listener first, then restores once from the native lease before considering the initial
  launch URL. A successful restore suppresses that initial URL claim; no lease or an
  unexpected orchestration failure falls back to normal initial-link handling. This lets
  a fresh Metro JS runtime resume automatically with the same alias and no new link.
  Native app process death erases the lease and requires a fresh bootstrap.
- `registerTool({ name, description, inputSchema?, outputSchema?, annotations?, handler })`
  → `{ remove() }`. The disposer removes only its own registration (compare by
  registration identity, not name). Duplicate name registration logs a dev warning and
  overwrites.
- `useCordieriteTool(definition, deps?)` — `useEffect` wrapper around
  `registerTool`/`remove`.
- `postEvent(name, payload?)` — emits an `event` frame when active; silently drops (dev
  warning) otherwise.
- Unified listener: `addCordieriteListener(kind, cb)` with kinds `stateChange`,
  `error` (covers bootstrap parse/connect and socket errors), `sessionChange`.
- Schema handling: Standard Schema JSON exporter as in v1; when a schema lacks the
  exporter, log a dev warning that agents will see a shapeless tool.
- App-side handler timeout: if a handler exceeds the call timeout hint, reply
  `tool_timeout` and ignore the late result.

Native layer (iOS URLSession / Android OkHttp) keeps the v1 pinning implementation
(verified correct) with these required fixes: all connection state serialized behind a
single serial queue (iOS) / single-thread executor or lock (Android); iOS implements
TurboModule `invalidate` (cancel socket + `invalidateAndCancel` the URLSession) and
`didCompleteWithError`; protocol-level keepalive per §7; `connect` promise semantics
identical on both platforms (resolve after TLS + claim/resume frame is sent; reject on
pin mismatch and transport failure); Android reads `ALLOW_PRIVATE_LAN_ONLY` metadata
with `getBoolean`; non-`ServerTrust` auth challenges get `.performDefaultHandling`.

## 12. Policy & audit

- Policy applies at the daemon on every `tools.call` (CLI and MCP alike), keyed on the
  descriptor's `annotations`: `policy.default` (`allow`/`deny`) for tools without
  `destructiveHint`, `policy.destructive` (`allow`/`deny`) for tools with it, plus
  per-tool overrides `policy.tools["<alias>/<name>"]`. Denied calls return
  `policy_denied` and are audited. Interactive prompting is not implemented; the
  policy configuration leaves room for a future `prompt` value.
- Audit: every `tools.call` appends one JSONL record to `audit/<date>.jsonl`:
  `{ ts, sessionId, alias, tool, argsSha256, outcome: "ok"|"error"|"denied",
  errorType?, durationMs, caller: "cli"|"mcp" }`. Raw args are never logged.

## 13. Package layout

```
packages/
  shared/          @cordierite/shared — wire protocol v2 (messages, bootstrap codec,
                   tool descriptors, error types), RPC method/param/result types,
                   Standard Schema helpers. No runtime deps.
  cordierite/      CLI + daemon + MCP:
    src/daemon/    lifecycle (pidfile, UDS server, auto-spawn helpers), session engine,
                   link minter, tls (cert minting — reuse host-certificate.ts),
                   event bus, policy, audit
    src/rpc/       RPC client library (connect-or-spawn), shared by cli/ and mcp/
    src/cli/       command definitions + renderers (keep DI/testability patterns)
    src/mcp/       stdio MCP server
  react-native/    @cordierite/react-native (entries: ., /auto, /noop)
playground/        reference app (Expo dev build)
```

Tooling stays: bun workspaces, turbo, `bun test`, tsc builds. Node ≥ 20 for the daemon
(UDS + `AF_UNIX` on Windows). Windows support is best-effort; the control plane uses the
named-pipe path `\\.\pipe\cordierite-<user>` behind the same client API.

## 14. Current limitations

- Interactive consent prompts (the policy configuration reserves `prompt`).
- Remote relay / hosts outside the operator machine.
- Pinning an offline anchor CA that signs short-lived leaves (rotation uses overlapping
  pin sets; the anchor-CA design is a future option).
- Web/browser client (safe no-op stub only).
- Multiple endpoint candidates in the bootstrap payload.
