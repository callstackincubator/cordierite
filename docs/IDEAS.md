# Cordierite — Improvement Ideas & Findings

Collected from a full project review (2026-07-15). Items are grouped by theme and
roughly ordered by value within each group. File references point at the code as of
`v0.3.1` (commit `dbc5e10`).

## 1. Fix-now defects

- **Pre-claim disconnect kills the host (exit 0).** `commands/host.ts:599-611` stops the
  server whenever the active socket closes, without checking `claimed`. A rejected claim,
  malformed JSON, or any LAN process that completes a TLS+WS upgrade and disconnects
  (port scanner, `curl`) terminates the host — an unauthenticated remote DoS. CI sees
  success because the exit code is 0. The reporter's "still waiting after rejection" UI
  state is unreachable, so this looks like a regression.
- **No `error` listeners.** Neither the WebSocket (`host.ts:463-612`) nor control-API
  requests register `error` handlers; send-after-close or an aborted request body throws
  an uncaught exception and crashes the host process.
- **Malformed tool snapshot crashes the host.** `isToolRegistrySnapshotMessage` only
  checks `Array.isArray(tools)`; `tools: [null]` throws in the message listener.
- **Committed trust-anchor private key.** `playground/certs/dev-key.pem` is tracked
  (force-included by `playground/.gitignore`) and its SPKI hash matches the pins embedded
  in the playground app config. Purge from history, rotate pins, document keys as
  per-developer secrets.
- **Android `allowPrivateLanOnly` is silently always false.** The Expo plugin writes a
  manifest string, Android stores `android:value="true"` as Boolean, native reads it via
  `getString` → null → false (`CordieriteConnectionManager.kt:424`). Use `getBoolean`.
- **iOS TurboModule never invalidates.** No `invalidate` on `RCTNativeCordierite`; Metro
  reload mid-session leaks a live pinned socket, host stays claimed, reloaded JS can never
  reconnect until the app process is killed. Android implements it correctly.
- **iOS misses `didCompleteWithError`.** Abrupt transport death can leave state stuck at
  `"active"` forever; `closeEventPending` never fires and cleanup never runs.
- **Native state races.** Neither platform serializes connection state: iOS mutates
  manager fields from `Task {}` threads, the URLSession delegate queue, and the JS thread
  with no queue/actor (won't compile under Swift 6 strict concurrency); Android mixes the
  TurboModule thread and the OkHttp reader thread with no locks.
- **Unhandled promise rejections** on fire-and-forget `sendWire` paths (tool replies in
  `tool-invocation.ts:50,177`; registry sync in `registry-sync.ts:34,51`) when the socket
  races closed; also `Linking.getInitialURL()` has no `.catch` in `deep-link-install.ts`.
- **Stale disposer removes newer registration.** `registerTool(...).remove()` deletes by
  name only; an older disposer can delete a newer same-name tool after remount churn.
- **Error taxonomy destroyed at boundaries.** App-side `tool_error.type`
  (`tool_timeout`, `tool_not_found`, …) is re-wrapped at `host.ts:590-594` and again in
  `remote-control.ts:43-47`; `--json` consumers see `error.type: "tool_error"` with the
  real type two `details` levels deep. Preserve the wire type end-to-end.
- **Session ids can start with `-`** (~1.6% — base64url of random bytes) and then break
  CLI flag parsing (`--session-id -Abc…` is read as a flag).
- **`--open` undeclared.** Consumed at `command-options.ts:22` but never registered with
  cac — invisible in `--help`; also iOS-simulator-only (no `adb` equivalent).
- **Web stub crashes bootstrap.** `getState()` throws on web; a URL containing
  `?cordierite=` produces an unhandled rejection before the error listener is reached.
  The stub should return `"idle"` and only throw on `connect`/`send`.
- Smaller: dead `tool-registry.ts` (108 lines, fake builtin tools, imported nowhere);
  stale duplicate files in `packages/react-native/build/` with no `prepublishOnly`
  clean+build; plugin/gradle versions pinned at 0.1.0 vs package 0.3.1; `padBase64Url`
  strips padding (misnamed); duplicated session-id regex/coercion and `formatTtlSeconds`;
  unreachable `deviceInfo === "invalid"` branch; `detectHostIp` can pick Docker bridge
  (`172.17.0.1`).

## 2. Security hardening

- **Authenticate the local control API.** Preferred: unix domain socket with `0700` dir /
  `0600` socket. If TCP stays: per-host random bearer token stored in the registry file
  with `0600` perms, `Host`/`Origin` checks, request body size cap. Today a malicious web
  page can fire a no-preflight `POST /call` at the ephemeral localhost port and execute
  tools (response unreadable, side effects real).
- **Restrict registry file perms.** `$TMPDIR/cordierite-sessions/*.json` is written with
  default (world-readable) modes and contains the control port.
- **`maxPayload` + pre-claim limits.** `WebSocketServer` uses the 100 MiB `ws` default;
  no claim-attempt rate limit or unclaimed-connection idle timeout.
- **Timing-safe token comparison.** `host.ts:218,222` use `!==`; use
  `crypto.timingSafeEqual` on fixed-length buffers.
- **Key rotation design.** The pin anchor and the TLS key are the same key: rotation
  requires an app rebuild and compromise is permanent. Either pin an offline anchor key
  that signs short-lived leaf certs, or document staged rotation via overlapping pins
  (both native clients already accept a pin *set*).
- **Fail-closed LAN policy alignment.** JS auto-bootstrap hardcodes
  `requirePrivateIp ?? true` with no public API to change it (contradicts HANDSHAKE.md);
  native `allowPrivateLanOnly` defaults to false. Align defaults, expose configuration.
- **Keepalive.** No pings on either platform; half-open sockets go undetected (app shows
  `"active"` after the host is gone). OkHttp `pingInterval` / iOS `sendPing`.
- Consider rejecting (not ignoring) unknown post-claim message types; confirm the deep
  link (which embeds the token) is only ever emitted to the operator terminal/QR.
- **Audit log** (production readiness): JSONL record of every invocation — session,
  device, tool, timestamp, args hash, outcome.
- **Per-tool consent/authorization**: tool annotations (`readOnlyHint`,
  `destructiveHint`) declared at registration; host-side policy for gating destructive
  tools behind interactive approval or an allowlist.

## 3. Session lifecycle (the structural problem)

The current model is single-shot: one pending session per process, host exits on TTL
expiry (60 s default) and on disconnect, no way to mint a second bootstrap link. Target
environments (Metro reload, fast refresh, crashes, backgrounding, CI, agents) are
churn-heavy; every churn event currently costs a host restart + new deep link.

- Long-lived host that re-arms a fresh pending session after disconnect/expiry.
- App-side auto-resume: resume token issued at claim, reconnect with backoff within a
  grace window; registry retained across the gap.
- Multi-device: N concurrent sessions per host process instead of one process per device.
- `cordierite stop <session>`, daemon/detach mode, no orphaned hosts.
- Fix the registry write/delete race (fire-and-forget `persistState` vs
  `clearRuntimeState` file delete can resurrect a stale entry; PID reuse defeats the
  liveness prune).

## 4. Agent-native surface

- **MCP server mode — highest-value single feature.** Tool descriptors already carry full
  JSON Schemas end-to-end; mapping `/tools` → `tools/list` and `/call` → `tools/call` is
  nearly mechanical. Makes app tools directly consumable from Claude Code/Cursor/etc.
- **NDJSON event stream** for `host --json` (session_claimed, tools_changed,
  disconnected) — today an agent can only poll `cordierite session`.
- Persist `deep_link` + `expires_at` into the registry entry so `session --json` alone
  can script the whole flow.
- Default `--session-id` to the only live session; headless `keygen --out <path>
  [--force]` (currently TTY-only, unusable in CI).
- Warn when a schema library lacks the Standard Schema JSON-Schema exporter (valibot,
  zod 3) — schemas silently degrade to `{}` and agents get shapeless tools.
- Runtime failures in `--json` mode should be JSON on stderr, not bare text.

## 5. Protocol & feature ideas

- **Emulator fast-path transport:** for simulators/emulators skip deep links —
  `adb reverse` / `simctl openurl` hand over the bootstrap directly; deep link + QR stays
  the physical-device path.
- **App→host event/log channel:** apps publish events over the same socket; CLI
  `events --follow`; MCP notifications. Big win for agent debugging loops.
- **Streaming/progress frames** for long tool calls; configurable host call timeout
  (fixed 10 s today); app-side handler timeout (a hung handler currently holds forever).
- **IPv6 / multi-endpoint bootstrap:** v2 payload with address-family byte + 16-byte
  address; bracket IPv6 in `formatAgentWebSocketUrl`; optionally multiple endpoint
  candidates.
- Align iOS/Android `connect` promise semantics (iOS rejects on pin mismatch, Android
  reports only via the error event).

## 6. React Native DX

- Side-effect-free root import: move auto-bootstrap to an explicit
  `@cordierite/react-native/auto` entry; lazy TurboModule lookup (eager `getEnforcing`
  crashes in Expo Go the moment any value is imported).
- **Production compile-out story:** a `/noop` subpath or documented `__DEV__` conditional
  require so release bundles can drop the client, pins, and deep-link listener entirely.
- `useCordieriteTool(definition, deps)` hook; dev warning on duplicate tool names.
- Unified error/event surface (bootstrap listener vs client `error` listener vs
  per-platform connect rejections are three different channels today).
- `createCordieriteClient` leaks module listeners and double-answers `tool_call` if
  instantiated twice — add `dispose()` or enforce singleton.
- Drop the pre-serialized-string form of `send` (footgun; duplicates native validation).
- Plugin-side pin format validation (`sha256/` + 44-char base64) in `app.plugin.js`.
- Playground should render tools from `getRegisteredTools()` instead of a hardcoded list.

## 7. Testing

- Host runtime state machine has zero WebSocket-level tests (claim/reject/disconnect,
  `/call` correlation/timeout/concurrency, registry persist/cleanup). This is where the
  worst bug lives.
- `session-registry.ts` (pruning, malformed entries, PID liveness) untested.
- No native tests; highest value: cross-platform SPKI pin fixture (same cert → same
  `sha256/...` on Swift, Kotlin, and the CLI).
- Missing JS cases: outbound-send string path, event-bridge mapping, schema-exporter
  fallback, stale disposer, `installCordieriteDeepLinkBootstrap` with Linking mocks.

## 8. Strategic direction

- **Broker-daemon refactor** (see architecture proposal): long-lived daemon owns key +
  wss listener + N device sessions; CLI becomes a thin client over an authenticated local
  channel; daemon doubles as the MCP server. Resolves reconnect, multi-device, orphaned
  hosts, CI, and the agent surface at once; wire protocol only needs a resume message.
- **Dev-first, production-capable posture:** keep the architecture production-ready
  (pinning is the right model; review found no bypass) but make dev-only compile-out the
  documented default; treat production as opt-in gated on key-management runbook, pin
  rotation, authenticated control plane, per-tool consent, and audit logging. Note the
  app-store-review angle: an always-on deep-link listener opening a pinned socket is a
  reviewable "remote control" surface.
