# 17 — Documentation overhaul

## Goal

Rewrite user-facing and protocol documentation for v2 so a newcomer (human or agent)
can go from clone to invoking an app tool without reading source. Last task — the
behavior it documents is final.

## Depends on

Everything (01–16).

## Read first

- `docs/ARCHITECTURE.md` (source of truth), the final CLI `--help` output, the
  final package READMEs, `docs/HANDSHAKE.md` + `docs/REQUIREMENTS.md` (v1 docs to
  replace), root `README.md`.

## Scope

1. **Root `README.md`** — rewrite for v2: the pitch (unchanged in spirit), a 5-minute
   quickstart using the real flow (`keygen` → plugin config → `link --open ios-sim`
   → `invoke`), the MCP one-liner (add `cordierite mcp` to an agent's MCP config and
   the app's tools just appear), security summary (pinning, tokens, UDS control
   plane, policy/audit), platform matrix. Keep the Callstack footer/badges.
2. **`docs/PROTOCOL.md`** — replaces `HANDSHAKE.md` (delete it): the v2 wire protocol
   as implemented — bootstrap payload byte layout, message catalog with examples,
   state machine diagram, close-code table, keepalive rules. Cross-check every field
   against the shared package types, not against ARCHITECTURE.md prose (fix
   ARCHITECTURE.md if the two drifted — code wins, but note the diff in the commit
   body).
3. **`docs/REQUIREMENTS.md`** — update to describe v2 as current shape; move the
   resolved open questions (local API auth, reconnection, multi-host) into a
   "resolved in v2" note; keep genuinely open ones (anchor-CA rotation, interactive
   consent, relay).
4. **`docs/SECURITY.md`** (new) — threat model in one page: what pinning does and
   does not defend, key handling rules (never commit, `0600`, rotation via
   overlapping pin-sets with a step-by-step runbook), production guidance (policy
   config, audit, compile-out via `/noop`, app-store-review note about the deep-link
   listener), the localhost/UDS trust boundary.
5. **Package READMEs** — `packages/cordierite` (CLI reference table generated from
   the real commands; daemon lifecycle; MCP setup for Claude Code/Cursor with
   config snippets), `packages/react-native` (entries, API reference,
   `useCordieriteTool` example, compile-out recipe — most of this landed in task 12;
   review for accuracy), `packages/shared` (one paragraph: protocol types, who
   should depend on it).
6. **`docs/IDEAS.md`** — prune items delivered by v2; keep the rest as the live
   backlog with a header noting the v2 baseline.
7. **`docs/tasks/`** — add a line at the top of each completed task file: `> Status:
   done (<commit sha>)` (fill from git history).

## Out of scope

- Marketing site, blog posts, CHANGELOG generation (releases handle that).
- Any code change other than trivial doc-comment fixes discovered while
  cross-checking.

## Acceptance criteria

- Every CLI command/flag mentioned in docs exists in `--help` output and vice versa
  (do a manual diff pass; note it in the commit body).
- Every wire message documented in PROTOCOL.md has a matching type guard in
  `@cordierite/shared` (grep each `"type"` value).
- Quickstart executed literally on a clean checkout (fresh temp state dir) works up
  to the point requiring a device; simulator path executed if available.
- No references to `cordierite host`, `--session-id`, `HANDSHAKE.md`, or v1 payloads
  anywhere outside `docs/tasks/` history.
- `bun run lint/build/test` green (docs shouldn't affect it, but verify).

## Testing

Documentation task — the acceptance criteria's cross-check passes are the review.

> Status: DONE. See commit `task(17): ...` for details, including a small documented
> ARCHITECTURE.md §3/§5/§9 drift fix (code won, per this task's own rule) and the
> `skills/cordierite/` v1→v2 sweep (outside this task's Scope list but required by its
> own "no v1 references outside docs/tasks/" acceptance criterion).
