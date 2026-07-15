# 13 — Daemon policy engine & audit log

## Goal

Production-posture controls in the daemon: annotation-based tool-call policy and an
append-only audit log, per ARCHITECTURE §12. Every `tools.call` — CLI and MCP alike —
passes through both.

## Depends on

05 (uses the single-seam call path it left in place).

## Read first

- `docs/ARCHITECTURE.md` §3 (config + audit paths), §5 (`policy_denied`), §12 (spec).
- `packages/cordierite/src/daemon/` — config module (task 03), the `tools.call` seam
  (task 05), event bus (task 04).

## Scope

1. **`daemon/policy.ts`** — `evaluate(descriptor, session, config.policy) →
   "allow" | "deny"`:
   - per-tool override `policy.tools["<alias>/<name>"]` wins;
   - else `policy.destructive` if `annotations.destructiveHint === true`;
   - else `policy.default`.
   - Values are `"allow" | "deny"` only; reject other strings at config-load time
     with a clear error (the enum deliberately leaves room for a future `"prompt"` —
     mention that in the config error message).
   - Denied → `tools.call` returns `policy_denied` **without** sending any frame to
     the app; emit a `tool_call_finished` event with `outcome: "denied"`.
2. **`daemon/audit.ts`** — one JSONL line per `tools.call` attempt to
   `<state-dir>/audit/<YYYY-MM-DD>.jsonl` (file + dir mode `0600`/`0700`, created
   lazily, date from an injectable clock):
   `{ ts, sessionId, alias, tool, argsSha256, outcome: "ok"|"error"|"denied",
   errorType?, durationMs, caller: "cli"|"mcp" }`.
   - `argsSha256` = hex sha256 of the canonical JSON of `args` — **raw args are never
     written**.
   - `caller`: extend the RPC request context so `tools.call` carries an optional
     `caller` field; the MCP server sets `"mcp"`, the CLI `"cli"` (default `"cli"`).
   - Writes are serialized and non-blocking for the call path (append queue; an
     audit-write failure logs to stderr and increments a counter in `daemon.status`,
     it never fails the call).
   - Flush on shutdown (hook the task-03 teardown).
3. **Config plumbing** — `policy` validation moves into the task-03 config loader if
   not already strict; document the config shape in the config module's doc comment.
4. **Surfacing** — `daemon.status` gains `{ policy: <effective config>, audit:
   { path, failedWrites } }`. CLI `daemon status` renders it; `invoke` renders
   `policy_denied` with a hint naming the config file.

## Out of scope

- Interactive prompting. Log rotation/retention (date-per-file is enough for v2.0).
- Audit of non-call events (sessions are observable via `events`).

## Acceptance criteria

- Integration tests: destructive-hinted tool denied under
  `policy.destructive: "deny"` (RPC error `policy_denied`, no frame reaches the fake
  app client — assert on the fake's received messages); per-tool override beats the
  category rule; default-allow still audited.
- Audit file: one line per attempt across ok/error/denied outcomes; parseable JSONL;
  no raw args present (grep the file for a sentinel arg value); correct `caller` for
  a call made through the MCP server.
- Config with `policy.destructive: "prompt"` fails to load with the documented error.
- `bun run lint/build/test` green.

## Testing

Extend the task 04/05 daemon integration harness; use a temp state dir and read the
audit file directly in assertions.
