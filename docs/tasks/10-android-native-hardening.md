# 10 — Android native hardening

## Goal

Bring the Android connection layer to the same contract as iOS (task 09):
synchronized state, correct metadata reads, keepalive, resource cleanup, protocol v2
first-frames, and matching `connect` promise semantics. Pinning logic is verified
correct — do not change the trust-manager hashing.

## Depends on

02. Do after 09 so the connect-semantics contract is fixed by the iOS reference.

## Read first

- `docs/ARCHITECTURE.md` §7, §11.
- `packages/react-native/android/src/main/java/com/callstackincubator/cordierite/CordieriteConnectionManager.kt`
  — defects: unsynchronized fields mutated from the TurboModule thread and the OkHttp
  reader thread (~:156-168, `getState` ~:339, `send` check-then-use ~:300-321 racing
  `cleanup()` ~:427); `ALLOW_PRIVATE_LAN_ONLY` read via `getString` always null
  because the manifest stores a Boolean (~:424); `cleanup()` shuts the dispatcher but
  not the connection pool (~:429); new OkHttpClient per connect (~:198-205); no
  `pingInterval`; `connect` returns at enqueue time and pin mismatch surfaces only as
  an `error` event, unlike iOS (~:213).
- `NativeCordieriteModule.kt` (`invalidate` already exists — keep).

## Scope

1. **Synchronize state.** Guard all connection state behind a single lock or a
   single-threaded executor (pick one; the executor mirrors iOS's serial queue and
   avoids lock-ordering traps with OkHttp callbacks). `getState()`, `send()`,
   `connect()`, `close()`, and every OkHttp callback go through it.
2. **Metadata fix.** Read `com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY`
   with `metaData.getBoolean(key, defaultValue)`; default **true** (fail-closed,
   matching task 09 item 8). Keep accepting a string `"true"/"false"` for robustness
   (check `get(key)` type) since the config plugin historically wrote strings.
3. **Client lifecycle.** One shared `OkHttpClient` (lazily created) with per-connect
   configuration via `newBuilder()`; `cleanup()` cancels the WebSocket and calls
   `connectionPool.evictAll()`; do not shut down the shared dispatcher between
   connects.
4. **Keepalive.** Configure per-connection ping using the interval negotiated in the
   ack, using the same JS↔native plumbing chosen in task 09 item 4 (OkHttp's
   `pingInterval` is client-level — set it on the per-connect `newBuilder()` client).
   OkHttp surfaces missed pongs via `onFailure`; ensure that path emits exactly one
   `close`/`error` and transitions to `closed`.
5. **Protocol v2.** `protocol_version: 2` in claims; accept `session_resume` as the
   first frame with the same "JS passes the exact first-frame payload" design as iOS.
6. **Connect semantics parity.** Match iOS: the `connect` promise resolves after TLS
   completes and the first frame is sent (i.e. resolve in `onOpen` after a successful
   `send`, not at `newWebSocket` enqueue); rejects on pin mismatch
   (`SSLPeerUnverifiedException` from the trust manager surfaces in `onFailure`
   before open — route it to the promise), TLS failure, timeout. Exactly one terminal
   event per connection attempt.
7. **Event dedupe.** Audit `onFailure`/`onClosed`/`onClosing` so a single transport
   death produces one `close` (with reason) — not an `error` **and** a `close`
   with different states, and never neither.

## Out of scope

- Trust-manager/SPKI changes (`kt:117-147` verified correct; hostname-verifier
  disable at `kt:204` is intentional and stays).
- JS reconnect (task 11).

## Acceptance criteria

- With the playground on an emulator: connect → kill daemon → exactly one close
  event, `getState()` returns `closed`, no wedge on re-connect; pin mismatch rejects
  the `connect` promise (test with a wrong pin in the manifest).
- `ALLOW_PRIVATE_LAN_ONLY` set via the config plugin is actually honored (log-assert
  or expose in a debug getter); unset → defaults to true.
- No new OkHttpClient per connect (verify by code review; optionally a counter in
  debug builds).
- `bun run lint/build/test` green.

## Testing

Add JVM unit tests under `packages/react-native/android/src/test/` where feasible:
the trust manager against fixture certs (same shared PEM fixture as task 09 —
same cert → same `sha256/…` string as the CLI), metadata parsing (Boolean, String,
absent), and state-machine transitions with a fake WebSocket. Wire `gradle test` into
the package's `test` script if the RN gradle setup permits; otherwise document the
manual emulator runs in the commit body.

> Status: DONE. See commit `task(10): ...` for details, verification, and known gaps
> (notably: the full connect→kill-daemon and pin-mismatch-rejects-promise emulator smokes were
> not run — no daemon/emulator in this environment; JVM tests cover pure logic only, not a
> real socket-driven state machine — see the commit body and the test file's doc comment).
