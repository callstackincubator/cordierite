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

### Non-goals

Deliberately out of scope, so the boundaries of the design are explicit:

- Replacing all end-to-end UI testing.
- Arbitrary code execution inside the app — only pre-registered, named tools.
- Anonymous or unauthenticated remote access.
- Treating deep links as proof of authority.
- A general-purpose interactive consent UI. `policy: "prompt"` (§12) exists, but its only
  implemented gate is an MCP client that enforces `_meta["anthropic/requiresUserInteraction"]`
  — every other caller fails closed rather than getting a prompt of its own.
- Remote relay to hosts outside the operator machine.
- Pinning an offline anchor CA that signs short-lived leaf certs. The current model pins
  the same key used for the TLS leaf; overlapping pin sets are the supported rotation
  path — see `docs/SECURITY.md`.

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
  "eventBufferSize": 256,
  "policy": { "default": "allow", "destructive": "allow" },
  "advertisedIp": null,
  "scheme": null
}
```

`advertisedIp` overrides auto-detection of the address advertised in minted bootstrap
payloads. `scheme` is the deep-link URI scheme composed into `cordierite link`'s output
when `--scheme` is not passed (§10) — set it once here instead of on every invocation.
`eventBufferSize` caps the per-session `events.since` retention buffer (§5).

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
| `tools.list` | `{ selector? }` | `ToolsListEntry[]` — `ToolDescriptor` (full schema + annotations) plus the tool's effective `policy: "allow" \| "deny" \| "prompt"` (§12), resolved daemon-side |
| `tools.call` | `{ selector?, name, args, timeoutMs?, caller?: "cli" \| "mcp", consent?: "client" }` | `{ result, callId }` on success — `callId` lets a caller with several in-flight calls match `tool_call_progress`/`tool_call_finished` events back to this call; JSON-RPC error with `data.type` preserving the wire error type on failure. `caller` attributes the audit record (§12); `consent` is the MCP server's evidence of a `"prompt"`-policy human gate (§12) — absent for the CLI. |
| `tools.cancel` | `{ selector?, callId, reason? }` | `{ cancelled: boolean }` — sends `tool_cancel` (§7) to the app for a still-pending call; `false` for an unknown/already-finished `callId` or no active socket (a no-op, not an error) |
| `events.subscribe` | `{ sessionSelector?, kinds? }` | `{ ok: true }`, then `event` notifications on this connection |
| `events.since` | `{ selector?, since?, kinds?, limit? }` | `{ events: EventNotification[], cursor }` — pull counterpart to `events.subscribe`, draining the per-session retention buffer described below |

`SessionSummary`: `{ sessionId, alias, state, device: { manufacturer?, model?, os? },
createdAt, claimedAt?, suspendedAt?, toolCount }`.

`daemon.status`'s result also reports the effective policy config and audit surfacing:
`{ ..., policy: { default, destructive, tools? }, audit: { path, failedWrites } }` (§12).

Event notification payload: `{ kind, sessionId?, alias?, ts, data, seq }` where `kind` is one
of `daemon_started`, `link_created`, `link_expired`, `session_claimed`,
`session_suspended`, `session_resumed`, `session_revoked`, `session_expired`,
`tools_changed`, `app_event`, `tool_call_started`, `tool_call_progress`,
`tool_call_finished`. `seq` is a per-session cursor (§ below); daemon-wide events (no
`sessionId`) carry `seq: 0` and are never retained.

**Event retention (issue #6):** alongside the live `events.subscribe` fan-out, the daemon
keeps a per-session ring buffer of the last `eventBufferSize` events (`config.json`,
default 256; `tool_call_progress` is excluded — a single chatty call can emit far more of
these than the buffer holds, which would otherwise evict every retained `app_event`),
each stamped with a `seq` that increases monotonically per session. `events.since` drains
it — `since` is an exclusive lower bound on `seq`, `kinds` filters by event kind, `limit`
caps the response to the **oldest** N so paging forward with the returned `cursor` never
skips anything; the result's `cursor` is the `seq` of the last event actually **returned**
(so `since: cursor` on the next call resumes right after it), falling back to the session's
true high-water mark only when nothing was returned (an empty buffer, or every retained
event was filtered out by `kinds`) so an empty page still lets a caller skip past events it
explicitly excluded rather than re-scanning them forever. `selector` defaults the same way
as every other selector-taking method (§ above). A session's buffer is discarded the
instant it hits a terminal event (`session_expired`/`session_revoked`) — matching "terminal
states free the alias" (§6) — the terminal event itself is still delivered live, just never
retained; an unclaimed pending link's buffer is discarded the same way when it's
discarded for any reason (TTL, revoke, attempt-limit exceeded), even the paths with no
event kind of their own. This exists because MCP is strictly request/response (§9): without
it, an agent that calls a tool and then asks "what happened?" has already missed the
answer, since it was never subscribed at the moment the app pushed it.

**Error codes** (JSON-RPC `error.data.type`): `no_session`, `ambiguous_session`,
`unknown_session`, `session_not_active`, `tool_not_found`,
`tool_input_validation_error`, `tool_output_validation_error`, `tool_execution_error`,
`tool_serialization_error`, `tool_timeout`, `tool_cancelled`, `session_suspended`,
`policy_denied`, `invalid_request`. App-side error types must be preserved **verbatim**
end-to-end (daemon → RPC → CLI/MCP output); never re-wrap them under a generic type.

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

**[PROTOCOL.md](PROTOCOL.md) is the normative reference** for the message catalog, frame
rules, close codes, keepalive, and the `ToolDescriptor` shape. Don't duplicate it here; the
only things worth stating at the architecture level are the daemon-side invariants:

- Every post-claim message must carry the active `session_id`; a mismatch closes the socket
  rather than being tolerated.
- Registry snapshots and deltas are validated strictly before use — an invalid snapshot
  closes the socket (`invalid_registry`). Never index into unvalidated data.
- Keepalive is WebSocket-level, not JSON, so a wedged app is detected by the transport
  rather than by application-layer timeouts.

## 8. Bootstrap payload v2

Byte layout and delivery paths live in [PROTOCOL.md](PROTOCOL.md) §2. Two design points
belong here:

- The link is `<scheme>:///?cordierite=<payload>&pin=<sha256/...>`. The `pin` is a **separate
  query param, not part of the binary payload**, so adding it did not change the payload
  format and older builds that ignore it still work. Anything parsing the link must stop at
  the `&` — a naive "slice to end of string" swallows the pin and corrupts the payload.
- The `pin` matters only to a build whose effective `trust` is `"link"` (§11). Embedded pins,
  when configured, always win — see [SECURITY.md](SECURITY.md)'s "Trust modes".

## 9. MCP server

`cordierite mcp` starts a **stdio** MCP server (SDK: `@modelcontextprotocol/sdk`) that
proxies daemon RPC (auto-spawning the daemon like any client):

- `tools/list` mirrors the live registry. One session → tools under their own names;
  several → namespaced `<alias>__<name>`. Registry and session changes emit
  `notifications/tools/list_changed`, so an agent's tool list tracks the device.
- Tool calls, progress frames, errors (with their `type` preserved), and descriptor
  annotations all map through verbatim. Two semantics the MCP surface does add:
  `"prompt"`-policy consent (§12) — `tools/list` emits
  `_meta["anthropic/requiresUserInteraction"]` for a tool whose effective policy is
  `"prompt"`, gated on the connected client's `initialize` `clientInfo`, and `tools/call`
  echoes that gate back to the daemon as `consent: "client"`, only for a tool this same
  connection's most recent listing actually flagged — and cancellation: an MCP client's
  `notifications/cancelled` maps to `tools.cancel` (§5), only for a call that requested
  progress (the SDK only assigns a `progressToken`, and only the progress-tracked path
  opens the dedicated connection that learns `callId` while the call is still in flight;
  a non-progress call has no `callId` to cancel by until it has already resolved, at
  which point cancelling it is moot).
- Two built-in management tools, `cordierite_connect` and `cordierite_wait_for_session`,
  let an agent mint a bootstrap link, deliver it to an emulator/simulator, and wait for the
  claim — without shell access. This is what makes the agent path self-service.
- Two more built-in tools, `cordierite_events` and `cordierite_wait_for_event` (issue #6),
  give an agent a pull surface over `postEvent()`-pushed `app_event`s: `cordierite_events`
  is a thin proxy over `events.since`; `cordierite_wait_for_event` blocks for a matching
  event, draining the retained buffer for an already-arrived match before falling back to
  a live wait — closing the same race `cordierite_wait_for_session` doesn't have to worry
  about (a session is either claimed or not, but an event can fire between "the agent
  decides to wait" and "the wait subscription lands"). `timeoutMs` is capped server-side
  well under the 30-minute idle window a stdio MCP tool call gets before Claude Code aborts
  it for sending neither a response nor a progress notification; a call still running after
  about two minutes moves to a Claude Code background task, so its result may arrive well
  after the call returns.

## 10. CLI surface

The CLI is a **thin renderer over the RPC in §5** — it holds no state, opens no sockets, and
owns no keys. Every command is one RPC call plus formatting, which is why the CLI and the MCP
server can't drift in behavior: they are the same calls.

The per-command reference lives in the [`cordierite` package README](../packages/cordierite/README.md),
which is where it stays current. Global flags: `--json` (machine output, NDJSON for streams),
`--no-color`, `--state-dir`. The `--scheme` used to compose a deep link comes from the flag,
else `config.json`, else a clear error.

`cordierite invoke`: a SIGINT while the call is still pending cancels it (§5's
`tools.cancel`, via the RPC connection dropping) rather than leaving the app-side handler
running for a caller that has already exited; the process then exits reporting
`tool_cancelled`.

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
- `@cordierite/react-native/noop` — identical public API, inert implementation.
- `@cordierite/react-native/metro` — `withCordierite(config, { include })`, the supported way
  to swap the real entries for `/noop` at bundle time. It chains to any existing
  `resolveRequest` and derives the redirected specifiers from `package.json`'s `exports`, so
  a new entry point can't be silently missed.

**Inclusion and trust are two independent, explicit config decisions — neither is derived
from build type** (`docs/SECURITY.md` has the full threat-model writeup; this is the
config-surface summary):

- **Inclusion** is decided entirely by autolinking, outside this package — there is no
  `#if DEBUG` or `FLAG_DEBUGGABLE` gate in either platform's path. Whenever the module is
  linked, it registers (Android) and compiles in (iOS), unconditionally. The JS layer strips
  separately and additively: `noopIfNativeUnavailable` degrades the public API to exact
  `/noop` behavior whenever the native module isn't found, for any reason (excluded, or an
  environment like Expo Go that has none).
- **Trust** is decided by the explicit `trust` value — `"pin"` (embedded `cliPins` only) or
  `"link"` (the bootstrap link's `pin`, for that session). Defaults to `"pin"` when `cliPins`
  is non-empty, `"link"` otherwise. Two invariants matter more than the config surface:
  embedded pins always win over a link pin, so **config can only narrow trust, never widen
  it**; and an unrecognized `trust` value is a hard error at both config time and in native
  resolution, so a typo can't silently downgrade `"pin"` into permissive link TOFU.

The full config surface (option names, native keys, recipes) lives in the
[package README](../packages/react-native/README.md); the threat model lives in
[SECURITY.md](SECURITY.md).

Client behavior:

- On every successful claim/resume, native commits the latest `resume_token` lease before
  emitting the `session_ack` to JS. The lease is synchronous, native **process-memory
  only**, and never written to disk. It records transport suspension/disconnection time,
  which anchors `grace_s`; ack time does not. On socket loss, auto-reconnect with
  exponential backoff (0.5 s → 30 s cap, jitter) while the lease remains within grace,
  and re-send the full registry snapshot after every successful resume. Resume attempts
  pause in background and restart on foreground. A `1008` close is terminal in both
  directions — mid-session, and as the rejection of a claim/resume handshake: it is the
  daemon's "no retry of this frame can succeed" signal (`unknown_session`,
  `invalid_resume_token`, `link_expired`, …), so the session is lost immediately with the
  daemon's own reason rather than retried for the remainder of the grace window.
  Transport-level closes (`1011`, `1001`, `1006`) stay retryable.
- Installing the bootstrap explicitly or importing `/auto` registers the runtime URL
  listener first, then restores once from the native lease before considering the initial
  launch URL. A successful restore suppresses that initial URL claim; no lease or an
  unexpected orchestration failure falls back to normal initial-link handling. This lets
  a fresh Metro JS runtime resume automatically with the same alias and no new link.
  Native app process death erases the lease and requires a fresh bootstrap. Apps that
  drive bootstrap themselves and never install the listener must call the exported
  `restoreSession()` at startup — it is the only other reader of the lease, so skipping it
  drops a resumable session on every JS runtime replacement.
- `registerTool({ name, description, inputSchema?, outputSchema?, annotations?, handler })`
  → `{ remove() }`. The disposer removes only its own registration (compare by
  registration identity, not name). Duplicate name registration logs a dev warning and
  overwrites.
- `useCordieriteTool(definition, deps?, { enabled? })` — `useEffect` wrapper around
  `registerTool`/`remove`. `enabled` (default `true`) is the supported way to gate a tool by
  build variant without breaking the rules of hooks; registration is the app-side allowlist,
  and it is the only enforcement point inside the app's own trust boundary (§12).
- `postEvent(name, payload?)` — emits an `event` frame when active; silently drops (dev
  warning) otherwise.
- Unified listener: `addCordieriteListener(kind, cb)` with kinds `stateChange`,
  `error` (covers bootstrap parse/connect and socket errors), `sessionChange`.
- Schema handling: Standard Schema JSON exporter as in v1; when a schema lacks the
  exporter, log a dev warning that agents will see a shapeless tool.
- App-side handler timeout: if a handler exceeds the call timeout hint, abort its
  `AbortSignal`, reply `tool_timeout`, and ignore the late result.
- Cancellation: `tool.handler(args, context)`'s `context.signal` (`AbortSignal`) aborts on
  a `tool_cancel` frame (§7) or when the session's transport is lost (suspend) — the
  latter can't itself deliver `tool_cancel` (there is no socket left), so it aborts every
  in-flight handler directly instead. A handler that ignores the signal keeps running and
  replies normally, exactly as it did before cancellation existed; one that observes it
  and throws/rejects gets its `tool_error` sent as `tool_cancelled` (only for an
  explicit `tool_cancel` — a handler that throws after its own timeout still reports
  `tool_timeout`, not `tool_cancelled`). `AbortController`/`AbortSignal` are used directly
  from the global — RN has polyfilled both since 0.60 (`abort-controller` under
  `polyfillGlobal`), which covers every RN version this package supports (Expo SDK 52+ /
  RN 0.76+); only the older WHATWG surface is relied on (`aborted`,
  `addEventListener("abort", …)`), never `AbortSignal.timeout`/`.abort`/`.any`,
  `throwIfAborted()`, or `.reason` semantics, which that polyfill predates.

Native layer: iOS `URLSession`, Android OkHttp. Two rules keep the two platforms honest —
all connection state is serialized (an actor on iOS, a single-thread executor/lock on
Android), and `connect` has identical promise semantics on both (resolve once TLS is up and
the claim/resume frame is sent; reject on pin mismatch and transport failure). Behavior that
differs between platforms is a bug, not a platform detail; the parity tests exist to catch
it.

## 12. Policy & audit

- Policy applies at the daemon on every `tools.call` (CLI and MCP alike), keyed on the
  descriptor's `annotations`: `policy.default`/`policy.destructive`/per-tool overrides
  `policy.tools["<alias>/<name>"]`, each `"allow" | "deny" | "prompt"`. `allow`/`deny`
  behave as before; denied calls return `policy_denied` and are audited.
- `"prompt"` means "a human gate is required; if one cannot be guaranteed, deny" — it
  fails closed rather than silently behaving like `allow`. The only implemented gate
  today is MCP: `tools/list` emits `_meta["anthropic/requiresUserInteraction"] = true`
  for a `"prompt"` tool, per connection, only when the connected client's `initialize`
  `clientInfo` is known to enforce it (Claude Code ≥ v2.1.199 — every other client
  ignores the flag). `tools/call` then sets `consent: "client"` only for a tool this
  same connection's most recent `tools/list` actually flagged that way — not merely a
  tool whose live policy happens to be `"prompt"` on a client that happens to qualify —
  so a call can't ride on a stale or hypothetical listing. Every other caller (CLI, an
  older or non-compliant MCP client) is denied with `policy_denied`, reason
  `no_consent_channel`.
  - This is evidence the flag was *emitted*, not that a human answered a prompt: the
    daemon never observes the client's own permission-prompt UI or its answer, only
    that the call arrived carrying the marker. `clientInfo` is self-reported, and
    `consent` is an ordinary RPC param on `daemon.sock` — any local process that can
    reach the socket (the CLI, or an agent with shell access, which is the typical
    Claude Code setup this feature targets) can set it directly, same as it could send
    any other RPC call. `"prompt"` guards against a compliant client silently
    auto-approving on the caller's behalf; it is not a defense against a hostile
    process on the operator's own machine — see `docs/SECURITY.md`'s threat model,
    which already treats socket access as full daemon control.
  - Two client-observable behaviors worth documenting rather than filing as bugs:
    non-interactive Claude Code (`--permission-prompt-tool`) converts an `allow` result
    for a flagged tool into a denial (`MCP tool requires user interaction; not
    supported via --permission-prompt-tool`) — that conversion is the client's, not
    the daemon's. And `"prompt"` denies unconditionally in any unattended pipeline
    (CI has no consent channel at all); pipelines that need a tool to run
    unattended must set `allow`/`deny` explicitly for it rather than `"prompt"`.
- Audit: every `tools.call` appends one JSONL record to `audit/<date>.jsonl`:
  `{ ts, sessionId, alias, tool, argsSha256, outcome: "ok"|"error"|"denied"|"cancelled",
  errorType?, durationMs, caller: "cli"|"mcp"|"client", consent?: "client" }`. `consent` is set
  only when a `"prompt"` call proceeded on the MCP client-gate channel above — kept
  distinct from a plain `"ok"` since the daemon never observes the consent decision
  itself, only that the call arrived carrying this marker. Raw args are never logged.

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

Tooling stays: pnpm workspaces, turbo, Vitest, tsc builds. Node ≥ 20 for the daemon
(UDS + `AF_UNIX` on Windows). Windows support is best-effort; the control plane uses the
named-pipe path `\\.\pipe\cordierite-<user>` behind the same client API.

## 14. Current limitations

- Interactive consent prompts (the policy configuration reserves `prompt`).
- Remote relay / hosts outside the operator machine.
- Pinning an offline anchor CA that signs short-lived leaves (rotation uses overlapping
  pin sets; the anchor-CA design is a future option).
- Web/browser client (safe no-op stub only).
- Multiple endpoint candidates in the bootstrap payload.
