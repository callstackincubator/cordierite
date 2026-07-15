# 16 — End-to-end integration test suite

## Goal

One suite that exercises the whole operator-machine stack — CLI ⇄ auto-spawned daemon
⇄ pinned wss ⇄ scripted app client — across the lifecycle scenarios that motivated
v2. This is the regression net for the daemon era (v1's worst bug lived exactly where
no test reached).

## Depends on

All daemon/CLI/MCP tasks (03–08, 13). RN/native tasks are exercised only via the
scripted Node app-client (real devices are out of scope).

## Read first

- `docs/ARCHITECTURE.md` §4–§9 (the behaviors under test).
- The integration harnesses built in tasks 04, 05, 08 — reuse and consolidate; do
  not write a third harness.

## Scope

Create `packages/cordierite/src/__tests__/e2e/` (bun test, each case in a fresh temp
`CORDIERITE_STATE_DIR`, built CLI invoked as a subprocess — not imported — so argv
parsing, exit codes, and auto-spawn are covered for real):

1. **Fixture: scripted app client** — a small Node `ws`-based fake app with helpers:
   `claim(link)`, `resume()`, `registerTools([...])`, `answerCalls(handler)`,
   `emitEvent(...)`, `dropSocket()`, plus SPKI pin verification of the daemon cert
   against the `keygen` output (this makes the fake validate the same trust chain the
   real apps do — decode pin, connect with a checkServerIdentity that computes SPKI
   sha256).
2. **Scenarios** (each a test):
   - *Cold start*: `keygen --out` → `link --json` (daemon auto-spawns) → claim →
     `ls` shows ACTIVE with alias → `tools`/`invoke` round-trip → `revoke` →
     `daemon stop` leaves no socket/pidfile.
   - *Churn*: claim → `dropSocket()` → `ls` shows SUSPENDED → `invoke` fails
     `session_suspended` → `resume()` → `invoke` succeeds → grace expiry (short
     configured grace) → EXPIRED and alias freed.
   - *Multi-device*: two fake clients, distinct aliases, selector disambiguation
     (`invoke` without selector errors `ambiguous_session`; with alias works),
     `revoke` one leaves the other untouched.
   - *Hostility*: while a session is ACTIVE — a raw TLS client that connects and
     disconnects, a client sending 300 KiB frames, binary frames, garbage JSON, and
     wrong-token claims — the daemon survives all of it and the ACTIVE session keeps
     invoking successfully afterward (the v1 killer scenario).
   - *Events*: `events --json` NDJSON stream captures claim → tools_changed →
     app_event → tool_call_started/finished → suspended in order.
   - *Policy/audit*: destructive deny + audit line assertions (may reuse task 13's
     coverage but drive it through the real CLI subprocess here).
   - *MCP*: MCP client over stdio against `cordierite mcp` subprocess: list/call/
     list_changed with the fake app (consolidates task 08's in-process test at the
     subprocess level).
   - *Daemon restart*: kill the daemon (SIGKILL) mid-session → next CLI command
     auto-spawns a fresh daemon (stale pid/socket recovered) → old session is gone
     (documented behavior: sessions do not survive daemon death) → new link/claim
     works.
3. **Runtime budget** — keep the suite < 90 s (tune grace/TTL via config; timers in
   the daemon must already be configurable from tasks 03/04).
4. Wire into turbo: root `bun run test` runs it; add a `test:e2e` script if isolation
   from unit tests helps CI.

## Out of scope

- Real device/simulator automation. Performance benchmarks.

## Acceptance criteria

- Every scenario above implemented and green; suite is deterministic across 5
  consecutive runs (`for i in 1..5`) — no timing flakes (use event subscriptions, not
  sleeps, for synchronization).
- `bun run lint/build/test` green from root.

## Testing

This task *is* testing. Review for flake-resistance: no bare `setTimeout` waits; all
synchronization via `events.subscribe` or process exit.
