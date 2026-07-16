# 04 — Daemon session engine: TLS listener, links, claim/resume, state machine

> Status: done (f54b09a)

## Goal

The heart of v2: the single pinned-TLS WebSocket listener, pending-link minting,
claim/resume handling with rotated resume tokens, the session state machine
(PENDING → ACTIVE ⇄ SUSPENDED → EXPIRED, REVOKED, DISCARDED), per-session tool
registries, keepalive, and the internal event bus. Includes all pre-auth hardening.

## Depends on

02, 03.

## Read first

- `docs/ARCHITECTURE.md` §5 (aliases, events), §6 (state machine — implement exactly),
  §7 (wire protocol, close codes, keepalive), §8 (payload the links must encode).
- `src/host-certificate.ts` (reuse as-is for cert minting) and `src/spki-pin.ts` —
  both kept through task 01.
- Optional context: the deleted v1 host (`commands/host.ts`, removed in task 01) is
  viewable via git history (`git show $(git rev-list -1 HEAD -- packages/cordierite/src/commands/host.ts)^:packages/cordierite/src/commands/host.ts`).
  Its key defects are already inlined in this file — you do not need it to implement.

## Scope

New modules under `packages/cordierite/src/daemon/`:

1. **`tls.ts`** — load the private key from `config.keyPath` (refuse group/world-
   readable files; refuse missing file with a message pointing at `cordierite keygen`),
   mint the leaf cert via the existing `host-certificate.ts`, compute the SPKI pin,
   re-mint when the advertised IP set changes. Expose `pinnedKeys` for `daemon.status`.
2. **`address.ts`** — advertised-address detection: prefer non-internal IPv4, exclude
   docker/CGN ranges (`172.17.x` bridge, `100.64/10`), support IPv6, allow config
   override. (Fixes v1 `detectHostIp` picking the Docker bridge.)
3. **`links.ts`** — `createLink(ttlSeconds?)`: sessionId 12 random bytes base64url
   **re-rolled if it starts with `-`** (v1 ids beginning with `-` broke CLI flag
   parsing), 32-byte token, expiry timer → DISCARDED + `session_expired`-style event
   (`link_created` on mint). Encodes the bootstrap v2 payload via shared.
4. **`sessions.ts`** — the state machine per §6. Claim path: first message on a socket
   must be `session_claim` or `session_resume` (else close 1008); validate with shared
   guards; token check via `crypto.timingSafeEqual` on fixed-length buffers; ≤5 failed
   claim attempts per pending session then invalidate it; on success mint + store
   `resume_token`, derive the alias (§5), reply `session_ack`, emit `session_claimed`.
   Resume path: match sessionId in SUSPENDED (or ACTIVE — treat as socket replacement:
   close the old socket, adopt the new), timing-safe resume-token check, rotate token,
   ack, emit `session_resumed`. Suspend on socket close/error/heartbeat loss: keep
   registry + alias, start grace timer (`graceSeconds`) → EXPIRED. `revoke()` from RPC.
5. **`registry.ts`** — per-session tool registry fed by validated
   `tool_registry_snapshot` (authoritative replace) and `tool_registry_delta`; invalid
   registry content → close 1008 `invalid_registry` (never index unvalidated data —
   v1 crashed on `tools: [null]`). Emits `tools_changed`.
6. **`listener.ts`** — `https.createServer` + `ws` `WebSocketServer` with
   `maxPayload: 256 * 1024`; unclaimed-socket timeout 10 s (`pre_claim_timeout`);
   binary frames → close 1003; malformed JSON → close 1008 `invalid_json`; post-claim
   `session_id` mismatch → close 1008 `session_mismatch`; unknown post-claim type →
   close 1008 `unknown_message_type`; **`error` listeners on server and every socket**
   (v1 crashed on unhandled `'error'`); server-side ping every
   `keepaliveIntervalSeconds`, suspend after 2 missed pongs. **A socket closing must
   never stop the daemon or the listener** — v1's fatal bug was exactly this.
7. **`event-bus.ts`** — typed in-process emitter for the §5 event kinds; the RPC layer
   (task 05) and audit (task 13) subscribe to it.
8. Wire into the composition root: `daemon.status` now reports real sessions and
   `pinnedKeys`; add RPC handlers for `link.create`, `sessions.list`,
   `sessions.describe`, `sessions.revoke` (selector resolution per §5 including
   `no_session`/`ambiguous_session`/`unknown_session`).

## Out of scope

- `tools.list` / `tools.call` / progress / `events.subscribe` RPC (task 05).
- Policy/audit (task 13). CLI rendering (task 06).

## Implementation notes / gotchas

- Timers: TTL, grace, pre-claim, heartbeat — every timer must be cleared on state
  transitions and on daemon shutdown; use injectable clock/timer seams for tests.
- Multiple sockets racing to claim the same pending link: first valid claim wins,
  the loser gets closed 1008 `already_claimed`.
- The registry write/delete race from v1 (`persistState` vs `clearRuntimeState`)
  disappears because there are no per-session files anymore — all session state is
  in-daemon-memory. Do not reintroduce file persistence.

## Acceptance criteria

- Full lifecycle exercisable with a plain Node `ws` client in tests (pin check skipped
  client-side via `rejectUnauthorized: false` — client pinning is the app's job):
  mint → claim → ack (with alias + resume_token) → snapshot → suspend on disconnect →
  resume with rotated token → revoke.
- Rejection matrix each closes with the specified code/reason and **leaves the daemon
  and other sessions running**: wrong token, expired link, 6th claim attempt, resume
  with stale token, mismatched session_id post-claim, binary frame, >256 KiB frame,
  malformed JSON, unclaimed socket idle 10 s, `tools:[null]` snapshot.
- Two devices connected concurrently, distinct aliases (`pixel-8`, `pixel-8-2`).
- `bun run lint/build/test` green.

## Testing

This module had **zero** WebSocket-level tests in v1 and hid the worst bug there. The
acceptance matrix above is the test plan — implement it as integration tests over real
sockets (self-signed cert from a throwaway key, injected state dir), plus unit tests
for alias slugging and address selection.

> Status: DONE. See commit `task(04): ...` for details.
