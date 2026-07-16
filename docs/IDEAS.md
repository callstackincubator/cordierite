# Cordierite — Improvement Ideas & Backlog

Collected from a full project review (2026-07-15), against `v0.3.1` (commit `dbc5e10`).
The v2 daemon refactor (`docs/ARCHITECTURE.md`, tasks 01-16) shipped almost everything
below: the broker-daemon architecture, the MCP server, session suspend/resume, the UDS
control plane, policy + audit, keepalive, timing-safe tokens, native hardening, the RN DX
items, and most of the fix-now defects. This file keeps only what's still genuinely open
against the v2 baseline (`v0.4.0-rc.1`, task 16's `ca5182f`) as the live backlog — check
`docs/ARCHITECTURE.md` §14 and `docs/REQUIREMENTS.md`'s "genuinely open questions" before
adding to it, since some of what looks open here is already a deliberate v2.0 non-goal.

## Still open

- **Anchor-CA rotation.** v2 kept the "pin anchor == TLS key" model with overlapping
  pin-sets as the rotation mechanism (`docs/SECURITY.md`). An offline anchor CA signing
  short-lived leaves is still only a documented future option
  (`docs/ARCHITECTURE.md` §14), not implemented.
- **Interactive consent.** The policy enum reserves a `"prompt"` value; no interactive
  approval flow exists yet. Today `policy.destructive`/`policy.tools[...]` is a static
  `allow`/`deny` decided ahead of time in `config.json`.
- **Remote relay.** Reaching a device with no direct network path to the operator
  machine (no LAN, no port-forward) has no supported story (`docs/ARCHITECTURE.md` §14).
- **Multiple endpoint candidates in the bootstrap payload.** The v2 payload carries one
  `(family, address, port)` triple; a future version could carry several so a device can
  try more than one path.
- **Windows named-pipe control plane** (`\\.\pipe\cordierite-<user>`) is documented as
  the intended shape (`docs/ARCHITECTURE.md` §13) but is best-effort/unverified — nothing
  in task 16's e2e suite runs on Windows.
- **Web client** is still a safe no-op stub only; no browser transport exists.
- **Registry write/delete races and PID-reuse edge cases** in whatever process-liveness
  checks remain outside the pidfile's own `O_EXCL` + `kill(pid, 0)` path deserve another
  look now that the daemon (not a per-session file) owns lifecycle — re-audit rather than
  assume this class of bug is fully gone.
- **Cross-platform SPKI pin fixture test** (same cert → same `sha256/...` on Swift,
  Kotlin, and the CLI) — still not automated; each platform's pin computation only has
  same-platform coverage.
- **`docs/tasks/`, `skills/cordierite/`** and any other agent-facing guide should be
  re-swept whenever the CLI surface changes again — task 17 brought them in line with
  v2.0, but nothing enforces that they stay that way as the CLI evolves.

## Delivered by v2 (kept here only as a pointer, not a task list)

Session lifecycle (suspend/resume, multi-device, daemon auto-spawn), the MCP server
(`cordierite mcp`, `cordierite_connect`, `cordierite_wait_for_session`), the UDS control
plane, policy + audit, keepalive, timing-safe token comparison, error-type preservation
end-to-end, the emulator/simulator fast path, IPv6 + bracketed URLs, native connection-
state serialization and `invalidate`/`didCompleteWithError` on iOS, the RN package's
`/auto` and `/noop` entries, `useCordieriteTool`, and non-interactive `keygen --out` are
all implemented — see `docs/ARCHITECTURE.md` and the task files under `docs/tasks/` for
which task shipped which piece.
