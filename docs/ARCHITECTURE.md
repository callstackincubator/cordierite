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
| `daemon.log.1` | previous `daemon.log`, kept by rotation (see below) | `0600` |
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
  "auditRetentionDays": 30,
  "daemonLogMaxBytes": 10485760,
  "policy": { "default": "allow", "destructive": "allow" },
  "advertisedIp": null,
  "scheme": null,
  "iosBundleId": null,
  "restartDaemonOnVersionMismatch": false
}
```

`advertisedIp` overrides auto-detection of the address advertised in minted bootstrap
payloads. `scheme` is the deep-link URI scheme composed into `cordierite link`'s output
when `--scheme` is not passed (§10) — set it once here instead of on every invocation.
`iosBundleId` is the same idea for `--open ios-device` (§8): the app `xcrun devicectl`
should launch, overridable per invocation by `--bundle-id` / the `bundleId` MCP argument.
`eventBufferSize` caps the per-session `events.since` retention buffer (§5).
`restartDaemonOnVersionMismatch` makes version-drift restarts unconditional rather than
only-when-no-sessions-are-live (§4, "Version drift").

**Retention.** Nothing under the state dir is unbounded:

- `auditRetentionDays` (positive integer, default 30) bounds `audit/`. The daemon prunes
  once at startup and every 24 h thereafter, deleting only files whose name matches
  `<YYYY-MM-DD>.jsonl` and whose (UTC) date is more than `auditRetentionDays` days behind
  today. The window is inclusive at both ends, so a fully-populated `audit/` holds up to
  `auditRetentionDays + 1` files — today's plus each of the `auditRetentionDays` days
  behind it — rather than exactly `auditRetentionDays`. Today's file is never touched,
  and neither is anything else in the directory.
  Pruning shares the audit write queue, so it cannot race an append; a failure is counted
  and warned like a failed write, never thrown. `daemon status` reports the retained file
  count, total size, and both failure counters — and reports the count and size as
  *absent* rather than zero when the directory could not be read at all, since "empty" and
  "we could not look" are different answers. A directory that does not exist yet is
  genuinely empty (it is created lazily) and reports zero.
- `daemonLogMaxBytes` (positive integer, default 10 MiB) bounds `daemon.log`. When a
  daemon is spawned — auto-spawn, or `cordierite daemon start`, which spawns through the
  same path (§4) — an over-cap `daemon.log` is renamed to `daemon.log.1` (mode `0600`,
  single backup, previous backup replaced) before the new log is opened. A running daemon
  never rotates its own log. An unreachable socket does not by itself prove the log is
  unheld — a booting, wedged, or shutting-down daemon still owns its fd, and rotating
  under one sends its output to a backup the next rotation then unlinks — so rotation
  also declines when `daemon.pid` names a live process or when `daemon.sock` accepts a
  connection, re-checked immediately before the rename. That narrows the window without
  closing it: a daemon spawned microseconds ago has neither yet, and closing it properly
  needs a lock held across spawn-and-ready rather than released at spawn. A rotation
  failure never blocks the spawn, and neither does a `daemon.log` mode that the
  filesystem refuses to set.

## 4. Daemon lifecycle

- `cordierite daemon run` — run in the foreground (what auto-spawn executes, and what
  systemd/launchd would use).
- `cordierite daemon start|stop|status` — explicit control. `start` spawns `daemon run`
  detached with stdio redirected to `daemon.log` (rotating it first if it is over
  `daemonLogMaxBytes` — §3); `stop` sends `daemon.shutdown` over
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
- **Version drift:** the daemon outlives the CLI that spawned it, so `npm i -g cordierite@<newer>`
  leaves the *old* daemon serving every later command — and a client that speaks a newer RPC
  surface (0.6.0's `tools.cancel`/`events.since`, say) gets an opaque "method not found" instead of
  a usable diagnosis. On its first connection, a CLI or MCP process therefore reads
  `daemon.status`'s `version` once and compares it with its own package version. One extra
  round-trip per process, not per request: the outcome is cached per daemon socket, and concurrent
  callers share a single check.
  - **Same version** — proceed, nothing else happens.
  - **The daemon is newer** — proceed, after one notice (stderr in human mode; suppressed under
    `--json`, which promises one machine-readable object and nothing else). A newer daemon already
    serves everything an older client asks for, and replacing it would downgrade the daemon out
    from under whichever newer install started it; two installs on one machine (a project-local
    `node_modules/.bin/cordierite` next to a global one) would otherwise take turns killing each
    other's daemon on every command. Versions are compared as semver, including §11's prerelease
    precedence — numeric identifiers compare numerically and rank below alphanumeric ones, and a
    prerelease ranks below its release, so `1.4.0-rc.1` does not restart `1.4.0` and `-rc.2` does
    not consider itself newer than `-rc.10`. Versions that differ only in spelling (`1.2` vs
    `1.2.0`, or `+build` metadata) are the same version: no restart and no notice. A version
    neither side can order is treated like a newer daemon — warn, never restart on a guess.
  - **The client is newer, and the daemon holds nothing** — the daemon is replaced transparently:
    `daemon.shutdown`, poll until both the socket and the pidfile are released (the daemon answers
    `shutdown` before tearing down, and releases the pidfile *after* the socket, so "socket gone"
    alone would race the replacement's `O_EXCL` pidfile acquisition), then the normal auto-spawn
    path. The whole sequence runs under the same exclusive spawn-lock as a cold start, and
    re-reads the version and the live state while holding it, so racing upgraded clients produce
    one replacement daemon.
  - **The client is newer, but the daemon holds live state** — the command fails with a
    `connection_error` naming both versions, what would be lost, and the remedies. "Live state" is
    connected sessions *and* links that are still claimable — minted, unclaimed, and inside their
    TTL (`pendingLinks`, §5; a link kept past its TTL only so a late claim can be told "expired"
    does not count, or an expired QR would hold off the upgrade for a further grace window).
    Restarting drops
    every session — resume tokens are in-daemon memory (§3, §6), so an app's resume after a restart
    fails closed with 1008 — and invalidates a deep link or QR code someone may be about to scan.
    Force it with the global `--daemon-restart` flag, `CORDIERITE_DAEMON_RESTART=1`, or
    `config.json`'s `restartDaemonOnVersionMismatch` (§3); `--no-daemon-restart` overrules the
    latter two for one command.
  - **At most one restart per process.** If the daemon now answering *still* reports a different
    version, the check stops and reports what it observed — the old daemon never exited, or another
    process spawned an older one — rather than retrying: each restart destroys whatever the daemon
    was holding, and a retry loop would kill daemon after daemon while blaming a cause that was
    never true. Losing the spawn-lock for the whole wait is reported as the lock it is, not as a
    replacement that failed: nothing was replaced in that case.
  - A daemon that is reachable but does not answer is **not** treated as gone: it is alive and
    busy, and spawning a second daemon over it would be the worst possible response. The check
    aborts with that diagnosis instead. The first `daemon.status` read uses the caller's ordinary
    request timeout; the reads and the `daemon.shutdown` issued *while the spawn-lock is held* use
    a 3 s one, so an unresponsive daemon cannot stretch the window in which no other process can
    spawn. The spawn-lock is likewise reclaimed if it has been
    held for more than 30 s, so a Ctrl-C mid-restart cannot poison the state dir permanently, and
    the socket-wait timeout names the lock path when one is present.
  - `daemon run` is the daemon; `daemon stop` is already the remedy; `daemon status` reports drift
    as a `warning` and never restarts the daemon it was asked to describe. `keygen` and `doctor`
    never open a daemon connection. The `cordierite/client` test SDK deliberately opts out, so a
    spec can never have the daemon restarted out from under a live app session.
  - Out of scope: drift introduced *after* a long-lived MCP server has started. Nothing re-checks
    an established connection; the operator restarts the MCP server. Drift found *at* MCP startup
    that cannot be resolved fails the whole server, so the agent loses every Cordierite tool rather
    than some of them — an MCP client renders that as a bare "server failed to start", so the
    server writes one stderr line naming both versions and the remedies before it exits. (Starting
    degraded, with the built-in management tools still answering, is a possible follow-up.)

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
| `daemon.status` | — | `{ version, pid, startedAt, wssPort, pinnedKeys: [spkiPin], sessions: SessionSummary[], pendingLinks }` — `pendingLinks` counts minted-but-unclaimed links (not sessions, §6, but live state a restart destroys; §4's version drift check reads it). Absent from daemons that predate this field. |
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

**`tools.call` deadline.** The daemon's per-call deadline is `timeoutMs ?? tool.timeout_ms`
— an explicit caller `timeoutMs` first, then the tool's own declared `timeout_ms` from its
descriptor (`docs/PROTOCOL.md` §5), then `DEFAULT_CALL_TIMEOUT_MS` (10 000 ms) for a tool
that declares nothing. Whatever that resolves to is clamped to
`[MIN_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS]` = `[1 000, 600 000]` ms; overshooting it
rejects with `tool_timeout`.

**A caller can shorten the deadline but cannot extend it past the app's own timer.** The
app runs an independent abort timer per call (§11), set from the tool's declared
`timeoutMs` or the client-wide `defaultToolTimeoutMs`, and it aborts the handler and
answers `tool_timeout` at that point no matter what the caller asked for. So a caller
`timeoutMs` below the app's timer genuinely shortens the call, while one above it only
moves the daemon's own giving-up point — the app still stops first. For a tool that
declares nothing, that ceiling is the app's 10 s default: `--timeout 60000` against such a
tool does not buy it sixty seconds. Extending a tool's budget is the app's decision, made
by declaring `timeoutMs` on the registration.

Callers that hold their own transport watchdog over a `tools.call` (the MCP server,
`cordierite invoke`, `cordierite/client`) must size it from the same arithmetic —
`deriveCallTransportTimeoutMs` (`daemon/calls.ts`) is that clamp plus 5 000 ms of slack —
so the daemon's `tool_timeout` always arrives first and the real error type reaches the
caller instead of a generic transport failure. A caller that knows the effective deadline
sizes the watchdog from it (the MCP server reads the tool's `timeout_ms` straight off its
`tools.list` entry); a caller that does not — `invoke` with no `--timeout`,
`AppClient.call` with no `timeoutMs`, both of which leave the deadline to the tool's own
undeclared-to-them value — sizes it from `MAX_TOOL_TIMEOUT_MS` instead. That
backstop is only ever reached by a daemon that accepts a request and then answers nothing:
a daemon that dies or drops the socket rejects every pending call at once
(`rpc/client.ts`'s `close` handler), so nothing waits on the long timer in practice.

`daemon.status`'s result also reports the effective policy config and audit surfacing:
`{ ..., policy: { default, destructive, tools? }, audit: { path, failedWrites, failedPrunes,
retentionDays, files, bytes } }` (§12, and §3 for the retention fields).

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
- **The address baked into the payload is decided by the delivery path, before the link is
  minted, and cannot be revised afterwards.** `--open android` and `--open ios-sim` force
  `127.0.0.1` because `adb reverse` and the simulator's shared network stack both make the
  daemon reachable there; every other path — a QR code, and the experimental `--open
  ios-device` (issue #31) — keeps the detected LAN address, because a physical phone has no
  such tunnel. `cli/open-target.ts`'s `usesLoopbackAddress` is the single predicate both
  `link.ts` and `mcp/connect-tool.ts` consult, so the CLI and MCP paths cannot disagree; it is
  also why `cordierite_connect` decides on a target *first* and mints a second, correctly
  addressed link when it falls back to a QR.
- `--open ios-device` is **explicit opt-in only**: `detectBootedTargets` enumerates booted
  simulators and attached Android devices and never runs `devicectl`, so a paired iPhone — which
  is often a personal phone, and which delivery may cold-launch — is never picked automatically.
  It is experimental: `devicectl`'s `--payload-url` is undocumented by Apple and cannot be
  exercised in CI, so all of it sits behind the injectable `ExecFn` seam. Prerequisites are in
  the [`cordierite` package README](../packages/cordierite/README.md).
- `devicectl list devices` returns **every CoreDevice the Mac has ever paired**, across platforms
  and regardless of whether it is connected, so entries are filtered before the "exactly one
  device" rule counts them — otherwise a paired Watch, or a phone in someone's pocket, turns the
  one connected iPhone into a spurious ambiguity error. The rules mirror the vendored Expo CLI's
  own `devicectl` integration (`@expo/cli`'s `AppleDevice.js`): exclude `tunnelState`
  `"unavailable"` and require `pairingState` `"paired"`, plus an iOS `platform` check. Note that
  `tunnelState: "disconnected"` is **kept** — a wired, trusted iPhone reports it routinely, since
  the tunnel is brought up on demand, so excluding it would drop exactly the device this target
  exists to reach. Filtering is client-side rather than via `devicectl --filter` so every rule is
  covered by the `ExecFn` tests instead of by an NSPredicate no test can evaluate. Each rule drops
  an entry only when the field is present and disqualifying — the one deliberate departure from
  Expo, which tests `pairingState` positively and would therefore find nothing at all if these
  undocumented keys were ever renamed; here that degrades to a loud launch failure instead.
- The bundle id is the launch argv's only **trailing positional**, so it is shape-validated
  (letters, digits, `.`, `-`) at each use site — a value starting with `-` would be read by
  `devicectl` as an option. It is *not* validated in `daemon/config.ts`, which keeps the plain
  non-empty-string check `scheme` uses: that loader runs on every daemon start, and a typo in a
  CLI-side convenience key must not stop the daemon from starting.
- `ios-device` also **refuses to deliver a loopback link**. `daemon/address.ts` falls back to
  `127.0.0.1` when it finds no routable interface; delivered to a phone, that link points the
  phone at itself, and the failure is silent — `wait_for_session` simply blocks for its whole
  timeout. Both the CLI and MCP paths check the minted `endpoint.address` and raise a usage error
  naming `advertisedIp` instead.

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
- **Schemas are gated on what MCP will actually accept** (issue #26). A client validates the
  entire `tools/list` result against the SDK's `ToolSchema`, so one entry it rejects makes the
  agent see *zero* tools from that app. `ToolSchema` requires `inputSchema.type` and
  `outputSchema.type` to be the literal `"object"` — excluding `z.array`, `z.string`, a
  `z.union`'s `anyOf`, and a `z.discriminatedUnion`'s `oneOf` or `z.intersection`'s `allOf` even
  when every branch is an object — *and* constrains `properties` to a record of object
  subschemas (the `properties: { a: true }` shorthand is rejected) and `required` to an array.
  Rather than restate those rules, `mcp/tool-mapping.ts` parses the composed tool with the SDK's
  own `ToolSchema`: a rejected `output_schema` is dropped, a rejected `input_schema` is replaced
  with the permissive empty object schema, and each degradation is logged once on stderr
  (deduped per session + tool + offending schema). The tool stays listed and callable either
  way. Only the MCP surface degrades — the daemon registry, `cordierite invoke`/`--json`, the JS
  client, and app-side result validation all keep the real schema.
- A tool whose `output_schema` *was* emitted always answers with `structuredContent`, because a
  client requires it for every tool it listed an `outputSchema` for; the emit decision and this
  one are literally the same predicate, so they cannot drift. A handler returning a non-object
  anyway (reachable only when the schema's validator is looser than its declared shape) fails as
  `tool_output_validation_error` content rather than as an opaque client-side protocol error. A
  tool whose schema was dropped, or that never had one, is unconstrained: its result is always
  JSON text content, and additionally `structuredContent` when the result happens to be an
  object — allowed, because the client has no schema to validate it against. One caveat is
  inherent to MCP: a client caches output schemas from the `tools/list` it last read, so if a
  tool's `output_schema` stops being emitted (the app re-registers it with a shape MCP rejects),
  a client still holding the older listing keeps demanding `structuredContent` for it until it
  re-lists. `notifications/tools/list_changed` fires on exactly that change, so the window is the
  client's own refresh latency, not something the server can close.
- A proxied `tools/call` sends the tool's own declared `timeout_ms` (clamped, §5) as the
  call's `timeoutMs` param, and sizes its daemon connection's request timeout from that same
  number via `deriveCallTransportTimeoutMs` (§5). It is sent explicitly rather than left to
  the daemon's `?? tool.timeout_ms` fallback so both numbers come from one value: the MCP
  server resolves the tool from a `tools/list` snapshot while the daemon reads its live
  registry, and a re-registration in between would otherwise leave a watchdog sized for the
  old deadline to fire first and mask the daemon's real `tool_timeout`. A tool that declares
  nothing gets the same 10 s default folded in by that clamp, so there is one number rather
  than a conditional. Without any of this the connection's own 10 s default would race the
  daemon's timer, and a long tool would surface as a generic transport error rather than
  being reachable at all.
- None of that lifts the MCP **client's** own per-request timeout, which is a third ceiling
  outside this daemon's control (the SDK's default is 60 s, and Claude Code allows a stdio
  tool call far longer). A tool declaring more than the calling agent will wait for still
  fails on the client side, so a genuinely long tool should report progress — a
  `progressToken` call resets many clients' idle timer — rather than rely on the deadline
  alone.
- Two built-in management tools, `cordierite_connect` and `cordierite_wait_for_session`,
  let an agent mint a bootstrap link, deliver it to an emulator/simulator, and wait for the
  claim — without shell access. This is what makes the agent path self-service. `target:
  "ios-device"` extends that to a paired physical iPhone/iPad (§8), but only when the agent
  names it and supplies `bundleId`; the "nothing detected" note says so, so an agent that
  finds no simulator knows the option exists rather than defaulting to a QR nobody scans.
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
`--no-color`, `--state-dir`, `--daemon-restart` (force a version-drift restart, §4). The `--scheme` used to compose a deep link comes from the flag,
else `config.json`, else a clear error.

`cordierite invoke`: a SIGINT while the call is still pending cancels it (§5's
`tools.cancel`, via the RPC connection dropping) rather than leaving the app-side handler
running for a caller that has already exited; the process then exits reporting
`tool_cancelled`.

## 11. React Native SDK

Package `@cordierite/react-native`. Entry points:

- `@cordierite/react-native` — **side-effect-free**. Its default API includes
  `registerTool`, `useCordieriteTool`, `postEvent`, `getRegisteredTools`,
  `addCordieriteListener`, `getCordieriteState`, `restoreSession`, and `connect`; it
  also exports `cordieriteClient`, parsing helpers, and types for advanced integrations.
  It installs nothing. TurboModule lookup is lazy (first native call), never at import
  time.
- `@cordierite/react-native/auto` — side-effect entry, and the only entry that installs
  the deep-link bootstrap and starts native-lease recovery. `require()` it instead of
  `import`ing to control when that happens (`__DEV__`, a QA-build toggle, after other
  startup work); installing twice installs once. It takes no options: address policy is
  native build config (`allowPrivateLanOnly`), read by the deep-link handler from the
  same `getConstants()` source native `connect()` enforces, so JS can only ever narrow
  what native allows, never widen it.
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
  `registerTool`/`remove`. It registers **once per mount**: the registered handler is a
  stable wrapper forwarding to the latest render's `definition.handler`, so a handler
  closing over component state is fresh on every call without re-registering. With `deps`
  omitted (the documented default) the effect keys off a derived, fixed-length dependency
  list of everything that changes the registry entry — `name`, `description`,
  `timeoutMs` (app-side only, but part of the entry), stringified `annotations`, the
  exported input/output JSON Schemas, and `enabled` — so a re-render never emits a
  `tool_registry_delta` pair or an agent-side `notifications/tools/list_changed`. Schemas
  are compared by identity first and re-exported only when the identity changed
  (hoisted/memoized schemas never re-export; an inline `z.object({…})` re-exports once per
  render and still matches by shape). A schema that exports no JSON Schema (zod 3, plain
  valibot) has no shape to compare, so it falls back to identity — "exports nothing" must
  not collapse into "no schema at all", which is what the entry's `outputSchema` presence
  and §7's optional `input_schema`/`output_schema` are keyed on. A caller-supplied `deps`
  is an explicit override with `useEffect`'s own semantics (`[...deps, enabled]`).
  `enabled` (default `true`) is the supported way to gate a tool by build variant without
  breaking the rules of hooks; registration is the app-side allowlist, and it is the only
  enforcement point inside the app's own trust boundary (§12). The JSON Schema exporter is
  injected into `createUseCordieriteTool` by the `.` entry and deliberately omitted by
  `./noop`, whose registrar registers nothing: the inert entry keys the effect off
  `enabled` alone and never imports schema export at all. `__tests__/noop-parity.test.ts`
  pins the API shape and arity; the behavioral half — that the inert entry never exports,
  and still honors `enabled` — is pinned by the "inert entry" cases in
  `__tests__/use-cordierite-tool.test.ts`.
- `postEvent(name, payload?)` — emits an `event` frame when active; silently drops (dev
  warning) otherwise.
- Unified listener: `addCordieriteListener(kind, cb)` with kinds `stateChange`,
  `error` (covers bootstrap parse/connect and socket errors), `sessionChange`.
- Schema handling: Standard Schema stays the only runtime-validation contract, but
  `inputSchema`/`outputSchema` accept three forms, classified once at registration by
  `normalizeToolSchema` (`schema.ts`) into `standard` / `paired` / `raw`:
  - a **Standard Schema** — anything carrying `~standard.validate`, object or callable
    (arktype's `Type` is a function) — validated with `~standard.validate`, published from
    `~standard.jsonSchema` (the Standard JSON Schema companion spec; zod 4 and arktype
    implement it, zod 3 and plain valibot do not).
  - a **`{ schema, jsonSchema }` pair** — validated with `schema["~standard"].validate`,
    published from the supplied JSON Schema object or `{ input, output }` converter. This
    is the supported path for zod 3 (`zod-to-json-schema`) and valibot
    (`@valibot/to-json-schema`).
  - a **raw JSON Schema object** — no `~standard`, a *plain* object (prototype
    `Object.prototype` or `null`), and an own `type`, if present, that is a JSON Schema type
    name or an array of them — published verbatim and handed to the handler **unvalidated**.
    `{}` qualifies: it is valid accept-anything JSON Schema. No JSON Schema validator is
    bundled: `@cordierite/react-native` keeps zero third-party runtime dependencies (§13).
    The optional `jsonSchema<T>()` helper is a pure type-level cast that gives such a handler
    real argument/result types.

  The raw test is structural rather than keyword-based on purpose. A keyword probe using `in`
  walks the prototype chain, and validator instances from libraries predating Standard Schema
  (yup, joi, superstruct, valibot 0.x) carry a prototype `type` — they would be taken as raw
  JSON Schema and published as the tool's shape, having previously been rejected outright.
  Many also hold circular references, so `JSON.stringify` on `tool_registry_snapshot` would
  throw and lose the whole snapshot, not just that tool.

  Everything else throws a `TypeError` at registration rather than being published as the
  tool's shape: non-objects and arrays, a `~standard` that is not a Standard Schema, any
  object mentioning `schema`/`jsonSchema` that is not a valid pair, and anything failing the
  plain-object rule. The `jsonSchema` half of a pair and every converter result are held to
  that same rule, so the forms cannot diverge in what they will publish.

  Separately from all of this, an **input schema should be object-typed at its root** to be
  usable over MCP — a root `enum`/`const`/`$ref`/`anyOf` is legal JSON Schema but leaves the
  agent with no named arguments (issue #34). This is documented, not enforced.

  Every way a slot can end up with no shape — a missing exporter, an exporter that throws or
  returns a non-object, a paired converter that does either — takes the same route: throw in
  `__DEV__`, warn once per tool name and register shapeless otherwise, so a shipped app is
  not bricked by an upgrade. Nothing is swallowed silently.

  Exported JSON Schema is not normalized or checked against a target dialect, and vendors
  differ in what they emit (`default` handling, `additionalProperties`, draft version), so
  two libraries describing the same shape may not produce byte-identical schemas. The wire
  `ToolDescriptor` (§7) is unchanged by any of this — it already carries draft 2020-12
  JSON Schema, so the whole contract is app-side.
- App-side handler timeout: if a handler exceeds the call timeout hint, abort its
  `AbortSignal`, reply `tool_timeout`, and ignore the late result. The hint is the tool's
  own `timeoutMs`, falling back to the client-wide `defaultToolTimeoutMs`. This timer is
  the real ceiling on a call: a caller's `tools.call` `timeoutMs` can shorten the deadline
  but never extend it past this point, because the app stops the handler here regardless.
  Only the
  *explicit* per-tool value travels on the descriptor (`docs/PROTOCOL.md` §5), where it
  becomes the daemon's default deadline for that tool (§5) — so a tool that declares one
  has the app timer and the daemon timer agree instead of the daemon giving up at 10 s
  first. `defaultToolTimeoutMs` deliberately stays app-side: putting it on the wire would
  silently retune the daemon's deadline for every tool in the app.
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
  Day files are pruned on the `auditRetentionDays` schedule described in §3, and
  `daemon status` surfaces the directory's file count, size, and failure counters.

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
  react-native/    @cordierite/react-native (entries: ., /auto, /noop). Depends only on
                   @cordierite/shared — no third-party runtime deps, which is why no
                   JSON Schema validator ships with it (§11's raw schema form).
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
- A tool whose `input_schema` is not object-rooted is listed but not usefully callable over MCP,
  because MCP tool arguments are always an object (§9). Wrapping such arguments so the tool stays
  callable is tracked in [issue #34](https://github.com/callstackincubator/cordierite/issues/34).
