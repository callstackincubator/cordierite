# 05 — Daemon: tool invocation path + full RPC surface

## Goal

Complete the daemon RPC: `tools.list`, `tools.call` with correlation/timeout/progress,
and `events.subscribe` streaming over the UDS. After this task the daemon is
feature-complete except policy/audit (task 13).

## Depends on

04.

## Read first

- `docs/ARCHITECTURE.md` §5 (methods, error preservation), §7 (`tool_call`,
  `tool_result`, `tool_error`, `tool_call_progress`, `event`).
- v1 context (files deleted in task 01; git history only, not required): the v1 host
  correlated calls with a `pendingCalls` map + `call_<random>` ids — that pattern was
  sound, keep it. Its defect was error flattening: the app's `error.type` got
  re-wrapped twice and ended up buried two `details` levels deep. v2 must preserve
  the type verbatim.

## Scope

1. **`daemon/calls.ts`** — invocation manager per session:
   - `call(session, name, args, timeoutMs)` → sends `tool_call` with id
     `call_<random>`, tracks it in a per-session pending map, resolves on
     `tool_result`, rejects on `tool_error` **carrying the app's `error.type`
     unchanged**, rejects `tool_timeout` after `timeoutMs` (default 10 000, allow
     1 000–600 000).
   - Unknown correlation ids in `tool_result`/`tool_error`/`tool_call_progress`
     frames are dropped (log at debug level).
   - Concurrent calls to the same session are supported and independently correlated.
   - On suspend/revoke/expiry, every pending call rejects immediately with
     `session_suspended` (or `unknown_session` on revoke).
   - `tool_call_progress` frames are forwarded to the event bus as
     `tool_call_progress` data attached to a `tool_call_started`-scoped stream (define
     a small internal shape `{ callId, progress?, message? }`).
2. **RPC `tools.list`** — resolve selector (§5), return the session's
   `ToolDescriptor[]` verbatim (schemas + annotations included). Session in
   SUSPENDED: still returns the retained registry (mark `state` in the result
   envelope so callers can tell).
3. **RPC `tools.call`** — resolve selector; session must be ACTIVE (else
   `session_not_active` / `session_suspended`); tool must exist in the registry
   (`tool_not_found` **without** sending a frame to the app); `args` must be a JSON
   object (`invalid_request`); delegate to `calls.call`; map failures to JSON-RPC
   errors with `data.type` from the shared union and `data.details` passthrough.
   Emit `tool_call_started` / `tool_call_finished` events (include `durationMs`,
   `outcome`).
4. **RPC `events.subscribe`** — mark the RPC connection as a subscriber with optional
   `sessionSelector` and `kinds` filters; from then on push `event` notifications
   (per §5 payload shape) for matching event-bus records until the connection closes.
   `app_event` kind carries the app's `event` frames (name/payload/ts). Multiple
   subscribers supported; a slow/dead subscriber connection must never block the
   daemon (write with backpressure guard — drop the connection if its buffer exceeds
   4 MiB).
5. **App `event` frames** — accept post-claim per §7 validation, forward to the event
   bus as `app_event`.

## Out of scope

- Policy checks and audit records on `tools.call` (task 13 inserts them into this
  path — leave a single obvious seam: one function through which every call passes).
- CLI/MCP rendering.

## Acceptance criteria

- Integration tests (real UDS + real ws app-client, per task 04 harness):
  - list → call → result round-trip, including schemas visible in `tools.list`.
  - App replies `tool_error` with `type: "tool_input_validation_error"` → RPC error
    `data.type === "tool_input_validation_error"` (verbatim; add one test per error
    type in the union).
  - Timeout: app never replies → `tool_timeout` after the configured `timeoutMs`.
  - Three concurrent calls interleaved out of order resolve to the right callers.
  - Suspend mid-call → pending call rejects `session_suspended`; after resume, a new
    call succeeds.
  - `events.subscribe` receives `session_claimed`, `tools_changed`, `app_event`,
    `tool_call_started/finished` in order for a scripted scenario; a second
    subscriber with a `kinds` filter receives only the filtered subset.
  - Unknown-session selector and ambiguous selector return the right error types.
- `bun run lint/build/test` green.

## Testing

Extend the task-04 integration harness. Prefer scripted fake app-clients (plain `ws`)
over mocks of the daemon internals — the value is in testing the real socket + RPC
path end to end.

> Status: DONE. See commit `task(05): implement daemon invocation RPC surface` for details.
