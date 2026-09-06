# Cordierite Wire Protocol v2

This document describes the protocol exactly as implemented: the bootstrap payload byte
layout, every message the daemon and app exchange after a pinned `wss://` connection is
established, the session state machine, and the close-code table.

Every type and validator referenced below lives in `@cordierite/shared`
(`packages/shared/src/domains/*.ts`) and is authoritative if this reference ever drifts.
See [ARCHITECTURE.md](ARCHITECTURE.md) for design rationale.

## Topology in one sentence

One long-lived `cordierite daemon` process holds the TLS private key and a single `wss://`
listener; any number of devices connect to it concurrently, each over its own pinned
socket, and each gets its own session.

## 1. Trust model

- The app does not trust the deep link, the local network, or the IP address by itself.
- The app trusts the daemon only because the TLS leaf certificate's SPKI hash matches an
  embedded `sha256/...` pin (or a pin in the pin *set* — plural pins let you roll keys
  without breaking already-shipped app builds; see `docs/SECURITY.md`).
- The deep link only carries bootstrap data for one pending session; it is a hint, not
  proof of authority. The session token inside it is short-lived and single-use.

## 2. Bootstrap payload (v2)

Deep link shape: `<scheme>:///?cordierite=<base64url-no-padding>&pin=<sha256/...>`. The
`cordierite` payload is unchanged from v1; `pin` is a separate, percent-encoded query param
carrying the daemon's SPKI fingerprint (see `docs/ARCHITECTURE.md` §8), appended by both
`cordierite link` and `cordierite_connect`. **Anything reading the payload must stop at the
`&`** — slicing to the end of the string swallows the pin and corrupts the blob.

The `cordierite` query value decodes to this binary layout — all multi-byte integers
big-endian:

| Bytes | Field | Notes |
| --- | --- | --- |
| 1 | `version` | always `0x02`; a v1 payload (`0x01`) is rejected outright, no fallback |
| 1 | `family` | `0x04` (IPv4) or `0x06` (IPv6) |
| 4 or 16 | `address` | 4 bytes for IPv4, 16 for IPv6, per `family` |
| 2 | `port` | |
| 1 + n | `sessionId` | 1-byte UTF-8 length prefix (1-255) + `n` UTF-8 bytes |
| 32 | `token` | raw bytes; the wire `session_claim.token` field is this same value base64url-encoded |
| 8 | `expiresAt` | unix **seconds** |

Encode/decode lives in `packages/shared/src/domains/bootstrap.ts` (`encodeBootstrap` /
`decodeBootstrap`). Decoding is strict: wrong version, unknown family byte, truncated or
oversized buffers (exact total-length check), a zero-length session id, invalid UTF-8 in
the session id, or port `0` all decode to `null` — never a partially-populated object.

`formatAgentWebSocketUrl` (in `domains/transport.ts`) composes the connect URL from an
endpoint and brackets IPv6 literals: `wss://[fd00::1]:8443` vs. `wss://192.168.1.10:8443`.

### Delivery paths

1. **Emulator/simulator fast path** (`cordierite link --open android|ios-sim`, or the MCP
   `cordierite_connect` tool's `target` argument): the daemon mints the link with the
   advertised address forced to `127.0.0.1`, `adb reverse`/`simctl openurl` delivers it —
   no human, fully scriptable.
2. **Physical device on LAN**: printed deep link + QR (`cordierite link --qr`).
3. **Physical iOS device, experimental** (`--open ios-device` / `target: "ios-device"`,
   issue #31): `xcrun devicectl device process launch --device <udid> --payload-url <link>
   <bundle-id>` hands the link to an installed, dev-signed app on a connected iOS 17+ device
   (`--relaunch` adds `--terminate-existing`; what a plain launch does to an *already-running*
   app is unverified on hardware). This is path 2's addressing with path 1's automation: the
   link keeps the **detected LAN address** — there is no `adb reverse` equivalent on iOS, so
   `127.0.0.1` would point the phone at itself, and a link that would advertise loopback is
   refused rather than delivered. Never auto-detected, and needs the app's bundle id.
4. **Remote/production**: the same deep link delivered out-of-band; policy and audit
   apply identically (§6 below, `docs/ARCHITECTURE.md` §12).

## 3. Connection-level rules

- **Text frames only.** A binary frame closes the socket with `1003
  binary_frame_not_supported`.
- **Max payload 256 KiB** in both directions (the `ws` server's `maxPayload`; clients
  enforce the same bound before sending).
- **Malformed JSON** → `1008 invalid_json`.
- **Unknown `type` after claim** → `1008 unknown_message_type` (strict: an unrecognized
  type is a protocol violation, not silently ignored).
- **Every post-claim message must carry the session's own `session_id`**; a mismatch →
  `1008 session_mismatch`.
- **Unclaimed connections are dropped after 10 s** (`1008 pre_claim_timeout`). The first
  message on a fresh socket must be `session_claim` or `session_resume`; anything else →
  `1008 expected_claim_or_resume`.
- **Keepalive is WebSocket protocol-level, not a JSON message.** The daemon pings every
  `keepaliveIntervalSeconds` (default 15s, from `config.json`); two missed pongs are
  treated as socket loss and the session is suspended (§5). Native clients (OkHttp
  `pingInterval`, iOS `URLSessionWebSocketTask.sendPing`) ping on the same interval and
  surface a missed pong as a connection error so the app SDK's reconnect logic engages.

## 4. Message catalog

Every message is a single JSON object, one per WebSocket text frame. Field-level
validation for each type lives in `packages/shared/src/domains/messages.ts`; the guards
listed here are exhaustive — the daemon closes the socket (`1008 invalid_message` or a
type-specific reason, §7) rather than partially trusting an invalid frame.

### `session_claim` — app → daemon, first message on a fresh socket

```jsonc
{
  "type": "session_claim",
  "protocol_version": 2,
  "session_id": "XzAERP54_Goh74hZ",
  "token": "<base64url, 32 raw bytes>",
  "device_manufacturer": "Apple",      // optional, ≤256 chars
  "device_model": "iPhone15,2",        // optional, ≤256 chars
  "device_os": "iOS 18.2"              // optional, ≤256 chars
}
```

Guard: `isSessionClaimMessage`. Requires `protocol_version === 2`, a non-empty
`session_id` (≤128 chars), a non-empty `token` (≤128 chars), and — if present — every
`device_*` field must be a string of ≤256 characters (any one invalid field rejects the
whole message, not just that field).

### `session_resume` — app → daemon, first message when resuming after a socket loss

```jsonc
{ "type": "session_resume", "protocol_version": 2, "session_id": "XzAERP54_Goh74hZ",
  "resume_token": "<base64url, 32 raw bytes>" }
```

Guard: `isSessionResumeMessage`.

### `session_ack` — daemon → app, success reply to both `session_claim` and `session_resume`

```jsonc
{ "type": "session_ack", "session_id": "XzAERP54_Goh74hZ", "status": "ok",
  "alias": "pixel-8", "resume_token": "<base64url, 32 raw bytes>",
  "keepalive_interval_s": 15, "grace_s": 600 }
```

Guard: `isSessionAckMessage`. `resume_token` is **rotated on every successful claim or
resume** — the previous token stops working the instant a new one is issued, so a client
must always use the token from its most recent `session_ack`, never a cached older one.

### `tool_registry_snapshot` — app → daemon, sent once the session is active

```jsonc
{ "type": "tool_registry_snapshot", "session_id": "XzAERP54_Goh74hZ", "tools": [
  { "name": "sum", "description": "Add two numbers.",
    "input_schema": { "type": "object", "properties": { "a": { "type": "number" }, "b": { "type": "number" } }, "required": ["a", "b"] },
    "output_schema": { "type": "object", "properties": { "total": { "type": "number" } } },
    "annotations": { "readOnlyHint": true },
    "timeout_ms": 60000 }
] }
```

Guard: `isToolRegistrySnapshotMessage`. Every array element must independently pass
`isToolDescriptor` (§5) — one invalid element invalidates the whole snapshot (close
`1008 invalid_registry`); the daemon never indexes into an unvalidated array element.
Sent authoritatively on first claim **and again after every resume** (it replaces, not
merges with, whatever the daemon retained across the gap).

### `tool_registry_delta` — app → daemon, sent when a tool is added or removed after the snapshot

```jsonc
{ "type": "tool_registry_delta", "session_id": "XzAERP54_Goh74hZ", "operation": "upsert",
  "tool": { "name": "sum", "description": "Add two numbers." } }

{ "type": "tool_registry_delta", "session_id": "XzAERP54_Goh74hZ", "operation": "remove",
  "name": "sum" }
```

Guard: `isToolRegistryDeltaMessage`. `"upsert"` requires a valid `ToolDescriptor` in
`tool`; `"remove"` requires a non-empty `name` (≤4096 chars); any other `operation` value
is rejected.

### `tool_call` — daemon → app, sent when an operator/agent invokes a tool

```jsonc
{ "type": "tool_call", "session_id": "XzAERP54_Goh74hZ", "id": "call_1", "name": "sum",
  "args": { "a": 2, "b": 3 } }
```

Guard: `isToolCallMessage`. `args` must be a JSON object (never an array or primitive).

### `tool_result` — app → daemon, success reply to a `tool_call`

```jsonc
{ "type": "tool_result", "session_id": "XzAERP54_Goh74hZ", "id": "call_1", "result": { "total": 5 } }
```

Guard: `isToolResultMessage`. `result` may be any JSON value (including `null`); the
guard only checks that the key is present, since `"result": null` is a legitimate
successful result.

### `tool_error` — app → daemon, failure reply to a `tool_call`

```jsonc
{ "type": "tool_error", "session_id": "XzAERP54_Goh74hZ", "id": "call_1",
  "error": { "type": "tool_execution_error", "message": "Something went wrong", "details": { "stack": "…" } } }
```

Guard: `isToolErrorMessage`. `error.type` must be one of the seven app-side error types
(§5 in `docs/ARCHITECTURE.md`): `tool_not_found`, `tool_input_validation_error`,
`tool_output_validation_error`, `tool_execution_error`, `tool_serialization_error`,
`tool_timeout`, `tool_cancelled`. This value is preserved **verbatim** all the way to the
CLI/MCP output — the daemon never re-wraps it under a generic `"tool_error"` type.

### `tool_call_progress` — app → daemon, optional progress updates during a long-running call

```jsonc
{ "type": "tool_call_progress", "session_id": "XzAERP54_Goh74hZ", "id": "call_1", "progress": 0.5, "message": "Halfway there" }
```

Guard: `isToolCallProgressMessage`. Both `progress` and `message` are optional; the
daemon maps this to a `tool_call_progress` event (`events.subscribe`) and, over MCP, to
an MCP progress notification.

### `tool_cancel` — daemon → app, cancels a still-in-flight `tool_call`

```jsonc
{ "type": "tool_cancel", "session_id": "XzAERP54_Goh74hZ", "id": "call_1", "reason": "client_cancelled" }
```

Guard: `isToolCancelMessage`. Sent when the caller that issued the matching `tools.call`
goes away while it is still pending — an MCP client's `notifications/cancelled`, the RPC
connection that issued `tools.call` dropping (CLI Ctrl-C, MCP client disconnect), or an
explicit `tools.cancel` RPC call. A cancel for an unknown or already-finished `id` is a
no-op, not a protocol violation — the daemon never knows for certain which calls the app
still considers in flight. The app is expected to abort the matching handler (its
`AbortSignal`, §11) and reply `tool_error` with `error.type: "tool_cancelled"`; a handler
that ignores the signal keeps running and replies normally, exactly as before this
message existed.

### `event` — app → daemon, app-originated telemetry outside the tool-call/result cycle

```jsonc
{ "type": "event", "session_id": "XzAERP54_Goh74hZ", "name": "screen_changed",
  "payload": { "screen": "Checkout" }, "ts": 1752600000000 }
```

Guard: `isEventMessage`. Emitted by `postEvent(name, payload?)` on the React Native
client; surfaced daemon-side as an `app_event` (`events.subscribe`, `cordierite events`) and
retained per-session (`events.since`, §8) so a request/response caller (an MCP client, a script)
can ask "what happened?" after the fact instead of only listening live.

## 5. Tool descriptor shape

```jsonc
{ "name": "sum",                       // required, unique per session, /^[a-zA-Z0-9_-]{1,64}$/
  "description": "Add two numbers.",   // required, 1-4096 chars
  "input_schema": { /* draft 2020-12 JSON Schema */ },   // optional
  "output_schema": { /* draft 2020-12 JSON Schema */ },  // optional
  "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true },
  "timeout_ms": 60000 }                // optional, positive integer
```

Schemas come from whatever the app registered the tool with: a Standard Schema JSON Schema
exporter (zod v4's built-in one, for example), the JSON Schema half of a
`{ schema, jsonSchema }` pair, or a raw JSON Schema object passed straight through — see
`docs/ARCHITECTURE.md` §11. A Standard Schema whose library has no exporter still registers
the tool, without `input_schema`/`output_schema`, so agents see a shapeless (`{}`) schema;
the app-side SDK throws on that in development rather than letting it ship silently. The
daemon never inspects a schema's internals — only that it is a JSON object.

`annotations` map 1:1 to MCP tool annotations and drive the daemon's policy engine
(`docs/ARCHITECTURE.md` §12):
`destructiveHint: true` routes a call through `policy.destructive` instead of
`policy.default`.

`timeout_ms` is the tool's own declared per-call deadline, in milliseconds, and must be a
positive integer when present — a snapshot carrying anything else (`0`, a negative, a
fraction, a string) fails `isToolDescriptor` and invalidates the whole snapshot. The daemon
uses it as the default deadline for a `tools.call` that carries no `timeoutMs` of its own,
clamped to `[1000, 600000]` like any caller-supplied value; an explicit caller `timeoutMs`
takes precedence, though a caller can only shorten the effective deadline, never extend it
past the app's own abort timer (`docs/ARCHITECTURE.md` §5). Note the spellings: `timeout_ms`
is snake_case here like every other protocol-defined descriptor field, while the RN
`registerTool` option and the `tools.call` RPC param are `timeoutMs` — those are camelCase
layers. A camelCase key on this descriptor is an unknown extra, not a deadline. It is the app's *explicit* per-tool value only —
never an app-wide default such as `defaultToolTimeoutMs`. Older apps omit the field
entirely and keep the daemon's 10 s default, so it is safe to add in either direction. It
is a daemon-side scheduling hint and is never emitted on the MCP `Tool` JSON.

## 6. Session state machine

```
                link.create
                    │
                    ▼
 ┌─► PENDING ──ttl expired──► DISCARDED
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

- `PENDING`: `{ sessionId, token, expiresAt }`. The token is compared with
  `crypto.timingSafeEqual` and is single-use — consumed on a successful claim, and
  invalidated outright after 5 failed claim attempts against that `sessionId`.
- `PENDING → DISCARDED`: the link's TTL elapsed before a claim; cheap, re-issue with
  `cordierite link` (or `cordierite_connect`) again.
- `PENDING → ACTIVE`: a successful `session_claim`. The daemon issues a `resume_token` in
  the `session_ack`.
- `ACTIVE → SUSPENDED`: socket close, socket error, or two missed keepalive pongs. Tool
  registry, device metadata, and alias are retained; any tool call already in flight
  fails fast with `session_suspended`.
- `SUSPENDED → ACTIVE`: a `session_resume` on a fresh pinned socket within
  `graceSeconds` (default 600) of suspension, with a valid (unrotated-since,
  unexpired) `resume_token`. The `resume_token` rotates again on this success, and the
  app is expected to re-send a full `tool_registry_snapshot` right after (§4) — the
  daemon treats it as authoritative and discards whatever it retained across the gap.
- `SUSPENDED → EXPIRED`: `graceSeconds` elapsed with no successful resume.
- Any state → `REVOKED`: `sessions.revoke` (CLI `cordierite revoke`, or the equivalent
  RPC call). Terminal states (`DISCARDED`, `EXPIRED`, `REVOKED`) free the session's alias
  for reuse by a future session.
- There is no cap on concurrent sessions; every session shares the one `wss://` listener.

## 7. Close-code table

Every close is `socket.close(code, reason)`; `reason` is a short machine-readable string,
not prose. Grouped by trigger:

| Code | Reason | When |
| --- | --- | --- |
| 1000 | `session_replaced` | a fresh claim/resume for the same session id supersedes a still-open socket |
| 1000 | `revoked` | `sessions.revoke` closed this session's socket |
| 1003 | `binary_frame_not_supported` | a binary WebSocket frame arrived (text frames only) |
| 1008 | `pre_claim_timeout` | no `session_claim`/`session_resume` arrived within 10 s of connecting |
| 1008 | `invalid_json` | a text frame did not parse as JSON |
| 1008 | `expected_claim_or_resume` | the first message on a fresh socket was some other type |
| 1008 | `unknown_message_type` | a post-claim message's `type` isn't in the known set (§4) |
| 1008 | `session_mismatch` | a post-claim message's `session_id` doesn't match this socket's session |
| 1008 | `already_claimed` | claim attempted against a session that already has an active socket |
| 1008 | `unknown_session` | claim/resume referenced a session id the daemon has no record of |
| 1008 | `link_expired` | claim attempted after the pending link's TTL elapsed |
| 1008 | `claim_attempts_exceeded` | the 5th failed claim attempt against a pending session — it is now unclaimable |
| 1008 | `invalid_token` | claim token didn't match (compared with `crypto.timingSafeEqual`) |
| 1008 | `invalid_resume_token` | resume token didn't match the session's current (rotated) token |
| 1008 | `invalid_registry` | a `tool_registry_snapshot`/`tool_registry_delta` failed validation (§4) |
| 1008 | `invalid_message` | a post-claim message matched a known `type` but failed that type's field guard |
| 1011 | `send_failed` | the daemon could not write to the socket (treated as socket loss, same as any other transport failure) |

## 8. Control-plane RPC (UDS)

The CLI and MCP server never touch the `wss://` listener, the private key, or state
files directly — every operation goes through newline-delimited JSON-RPC 2.0 over the
daemon's Unix domain socket. See [ARCHITECTURE.md](ARCHITECTURE.md#5-control-plane-rpc-uds)
for the complete method table, selector/alias rules, and event-kind list. The shared RPC
types also establish these details:

- `link.create` also accepts `addressOverride` (forces the bootstrap payload's advertised
  address — used by the emulator/simulator fast path to force `127.0.0.1`).
- `tools.call`'s result carries a `callId` alongside `result`, so a caller juggling
  several in-flight calls (the MCP server proxying concurrent `tools/call` requests) can
  match `tool_call_progress`/`tool_call_finished` events back to the call that produced
  them without guessing from data shape.
- `tools.cancel({ selector?, callId, reason? })` sends `tool_cancel` (above) to the
  session's app for a still-pending call; the result is `{ cancelled: boolean }`, `false`
  for an unknown/already-finished `callId` or when the session has no active socket to
  send the frame on. The RPC connection that issued a `tools.call` dropping while it is
  still pending triggers the same cancel automatically.
- `daemon.status`'s result additionally reports the effective `policy` config and
  `audit: { path, failedWrites, failedPrunes, retentionDays, files, bytes }`
  (ARCHITECTURE.md §12's audit surfacing, plus §3's retention footprint: how many
  `<YYYY-MM-DD>.jsonl` day files are retained and their total size). `files`/`bytes` are
  omitted when the daemon could not read the audit directory at all — absent means "not
  measured", never "empty". A daemon predating retention answers with only
  `path`/`failedWrites`, so a caller that may be talking to one should treat the rest as
  optional too.
- `events.subscribe` includes `link_expired` (a pending link's TTL elapsed with no
  claim) and `tool_call_progress` (mirroring the wire message in §4).
- `events.since` (issue #6) is the pull counterpart: it drains a per-session ring buffer
  the daemon retains alongside the live `events.subscribe` fan-out, so a caller that only
  finds out it wants to know "what happened?" after the fact (every MCP tool call, since
  MCP is strictly request/response) doesn't need to have been subscribed in advance. Every
  `EventNotification` carries a `seq`: a cursor that increases monotonically per session,
  assigned at retention time. Pass the highest `seq` seen back as `since` on the next call
  to resume without re-reading; a session-scoped event whose session hits a terminal state
  (`session_expired`/`session_revoked`) discards that session's buffer, matching "terminal
  states free the alias" (ARCHITECTURE.md §6) — there is no persisted history past that
  point. Daemon-wide events (no `sessionId`, e.g. `daemon_started`) are never buffered and
  carry `seq: 0`.
