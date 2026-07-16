# 11 — React Native JS client v2: resume, reconnect, unified events

> Status: done (eedb1b9)

## Goal

Rewrite the JS client core of `@cordierite/react-native` for protocol v2: claim →
resume lifecycle with in-memory resume tokens, automatic reconnection with backoff and
AppState awareness, the unified listener API, and fixes for the known v1 JS defects.

## Depends on

02 (protocol v2), 09 & 10 (native contract: first-frame payloads, keepalive plumbing,
connect semantics).

## Read first

- `docs/ARCHITECTURE.md` §7 (messages), §8 (bootstrap v2), §11 (the SDK spec —
  implement exactly, but note entry-point restructuring is task 12).
- Current sources and their defects:
  - `src/createCordieriteClient.ts` — fire-and-forget `void` promises leak unhandled
    rejections (~:80-84, 190-217); stale disposer removes newer same-name tool
    (~:183, 201-206); module listeners never removed (double-answer on a second
    client, ~:61-85).
  - `src/tool-invocation.ts` — `sendWire` outside try/catch at ~:50 and ~:177.
  - `src/registry-sync.ts` (~:29-51) — same race.
  - `src/deep-link-core.ts` — hardcoded `requirePrivateIp ?? true` (~:89) with no
    public configuration; calls `getState()` before guards (web crash, ~:82).
  - `src/deep-link-install.ts` — `getInitialURL().then` without `.catch` (~:23-25);
    run-once guard prevents options (~:9-20).
  - `src/CordieriteModule.web.ts` — `getState` throws; must return `"idle"` (only
    `connect`/`send` throw).
  - Keep: `src/schema.ts` (Standard Schema JSON export — works), `src/NativeCordierite.ts`
    spec (extend, don't replace).

## Scope

1. **Protocol v2 client state machine** (`src/client/` — restructure freely):
   - `connect(bootstrap)` — decode/validate the v2 payload (shared codec), pass the
     exact `session_claim` first-frame to native, await ack, store
     `{ sessionId, resumeToken, keepaliveIntervalS, graceS, alias }` **in memory
     only**.
   - On socket loss while a resume token is held: auto-reconnect sending
     `session_resume`, exponential backoff 0.5 s → 30 s cap with full jitter; stop
     when `graceS` has elapsed since the last ack, on `revoked`-style terminal
     close codes (1000 from `sessions.revoke`), or when a new bootstrap arrives.
   - Rotate the stored resume token on every ack. After every successful
     claim/resume ack, send a full `tool_registry_snapshot`.
   - **AppState**: entering background pauses reconnect attempts (do not tear down an
     open socket — the OS will); returning to foreground triggers an immediate
     attempt if disconnected and within grace.
2. **Registration registry**:
   - `registerTool(def)` returns `{ remove() }` whose disposer removes **its own**
     registration only (identity check, not name); duplicate names overwrite with a
     `console.warn` in `__DEV__`.
   - Deltas/snapshots per §7 with `annotations` passthrough.
   - App-side handler timeout: reject with `tool_timeout` if the handler exceeds the
     timeout (use the daemon default 10 s as the local ceiling; a late result is
     ignored with a dev warning).
3. **`postEvent(name, payload?)`** — `event` frame when active; dev-warn + drop
   otherwise.
4. **Unified listeners** — `addCordieriteListener(kind, cb)` for `stateChange`
   (`idle|connecting|active|reconnecting|closed` + reason), `sessionChange`
   (claimed/resumed/lost with alias), `error` (bootstrap parse, connect, socket, and
   tool-handler errors — one channel). Remove `addCordieriteErrorListener` outright —
   no deprecated aliases; breaking changes are free. Every listener registration
   returns `{ remove() }`.
5. **Bootstrap/deep-link core** — v2 payload only; `requirePrivateIp` becomes an
   option threaded from `installCordieriteDeepLinkBootstrap(options)` (default true;
   the run-once guard must compare options and warn on conflicting reinstall);
   private-range check must handle IPv6 (ULA `fc00::/7`, link-local `fe80::/10`,
   loopback). Fix the `.catch` and web-stub issues listed above.
6. **Robustness sweep** — every `sendWire`/native-send call path is awaited or
   `.catch`-ed; no `void somePromise()` without a rejection handler anywhere in the
   package (add an eslint guard if practical: `no-floating-promises` is already
   TS-eslint standard — enable it for `src/`).

## Out of scope

- Entry-point restructuring (`/auto`, `/noop`, side-effect-free root),
  `useCordieriteTool`, config plugin — task 12.
- Native code — tasks 09/10 (this task consumes their contract).

## Acceptance criteria

- Unit/integration tests (bun, mocked native module following the existing
  `__tests__` style): claim → ack → snapshot; socket loss → resume with rotated
  token → fresh snapshot; grace expiry stops retries and emits terminal
  `stateChange`; backoff schedule capped and jittered (inject timers); AppState
  background/foreground gating; stale-disposer case (A registers `foo`, B
  re-registers `foo`, A.remove() is a no-op); duplicate-name dev warning; handler
  timeout → `tool_timeout` frame; `postEvent` in both states; every v1 defect above
  has a regression test.
- `no-floating-promises` (or equivalent) passes on `src/`.
- `bun run lint/build/test` green.

## Testing

Extend the existing mocked-native test harness (`src/__tests__/client.test.ts` shows
the pattern). Fake timers for backoff/grace. Keep the connect-options parity test
concept updated for the v2 option surface.

> Status: DONE. See commit for details.
