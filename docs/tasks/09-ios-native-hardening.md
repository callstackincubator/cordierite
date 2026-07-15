# 09 — iOS native hardening

## Goal

Make the iOS connection layer correct under concurrency and app lifecycle: serialize
all state, implement TurboModule `invalidate`, handle abrupt transport death,
keepalive pings, protocol v2 frames, and fix the auth-challenge and LAN-policy
defects. Pinning logic itself is verified correct — do not change the SPKI hashing.

## Depends on

02 (protocol v2 shapes to speak). Independent of the daemon tasks.

## Read first

- `docs/ARCHITECTURE.md` §7 (keepalive, close codes), §11 (native requirements,
  connect semantics).
- `packages/react-native/ios/CordieriteConnectionManager.swift` — defects to fix:
  unsynchronized state mutated from `Task {}` threads, the URLSession delegate queue,
  and the JS thread (fields at ~:151-164); `close()` relies on `didCloseWith` which
  never fires on abrupt death (~:248-258, 526-554); `didCompleteWithError` not
  implemented; non-`ServerTrust` challenges cancelled with a bogus TLS error
  (~:470-488); no ping.
- `packages/react-native/ios/CordieriteTurboBridge.swift`,
  `RCTNativeCordierite.mm` — no `invalidate` implemented.

## Scope

1. **Serialize state.** Route every mutation/read of connection state through one
   serial `DispatchQueue` (or convert the manager to an `actor` if the TurboModule
   bridge allows async cleanly). Two rapid `connect` calls must deterministically
   yield one socket and one `already_connecting` rejection. Code should compile under
   Swift 6 strict concurrency (`-strict-concurrency=complete`) without warnings —
   treat that as the definition of done for this item.
2. **`invalidate`.** Implement TurboModule invalidation on `RCTNativeCordierite`:
   cancel the socket task (close code 1001), `invalidateAndCancel()` the URLSession,
   clear state, drop pending events. Metro reload must fully release the socket so
   the daemon suspends the session and the reloaded JS can resume.
3. **Abrupt-death handling.** Implement `urlSession(_:task:didCompleteWithError:)`:
   on error (or completion without a prior close frame), run cleanup, transition to
   `closed`, emit exactly one `close` event (dedupe with the `didCloseWith` path via
   the serialized state — `closeEventPending` today can leak or double-fire).
   `getState()` must never report `"active"` after the transport is gone.
4. **Keepalive.** After claim/resume ack, schedule `sendPing` every
   `keepalive_interval_s` from the ack (plumb the value from JS via the connect/ack
   flow — simplest: JS calls a new `setKeepaliveInterval(seconds)` after ack, or
   native parses the ack it already forwards; pick one and mirror it in task 10 for
   Android). Two consecutive ping failures → treat as transport death (item 3 path).
5. **Auth challenges.** Non-`ServerTrust` methods → `completionHandler(
   .performDefaultHandling, nil)` instead of cancelling with `tls_handshake_failed`.
6. **Protocol v2.** Send `protocol_version: 2` in `session_claim`; support sending
   `session_resume` as the first frame (native `connect` gains a mode/params for
   resume — keep native dumb: JS passes the exact first-frame payload; native just
   validates it is one of the two allowed types).
7. **Connect semantics** (parity contract with task 10): the `connect` promise
   resolves after TLS completes **and** the first frame (claim or resume) is sent;
   rejects on pin mismatch, TLS failure, timeout, invalid params. Keep the current
   iOS behavior; this is the reference implementation Android must match.
8. **LAN policy default.** `allowPrivateLanOnly` plist read stays, but align the
   default with ARCHITECTURE §11/fail-closed: default `true` when the key is absent
   (breaking change, intended; mirror in task 10 and the config plugin in task 12).

## Out of scope

- Any change to SPKI hash computation (`swift:557-616`) — verified correct.
- JS-side reconnect logic (task 11). Android (task 10).

## Acceptance criteria

- Builds clean with strict concurrency; playground (or a bare harness) runs on the
  iOS simulator: connect → kill the daemon process → app emits exactly one `close`
  event and `getState()` returns `closed`; Metro reload mid-session → daemon session
  suspends (verify via `cordierite ls`) and a fresh connect succeeds.
- No `already connecting or active` wedge after abrupt death or reload.
- `bun run lint/build/test` green (JS side unaffected but must still pass).

## Testing

There is no iOS unit-test target today; create one if feasible in the pod setup
(pure-logic tests: state transitions on the serial queue, SPKI fixture — same cert →
same `sha256/…` as `packages/cordierite/src/spki-pin.ts`, share the fixture PEM under
`packages/react-native/__fixtures__/`). Where a test target is impractical, the
simulator smoke script in the acceptance criteria is the fallback — document what was
run manually in the commit body.

> Status: DONE. See commit `task(09): ...` for details, verification, and known gaps
> (notably: connect-reentrancy and abrupt-death/keepalive were verified by full Xcode
> builds and a pure-logic XCTest target, not a live daemon/simulator smoke run).
