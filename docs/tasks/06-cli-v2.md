# 06 — CLI v2: thin client rewrite

## Goal

Build the full v2 CLI as a thin renderer over the daemon RPC per ARCHITECTURE §10.
After task 01's demolition the CLI exposes only `keygen` (plus `daemon …` from task
03); this task builds the rest and finishes `keygen` itself.

## Depends on

05.

## Read first

- `docs/ARCHITECTURE.md` §5 (selectors), §8 (deep-link composition), §10 (the exact
  command table — implement it verbatim).
- Kept CLI plumbing: `src/cli/create-cli.ts`, `dispatch.ts`, `runner.ts`,
  `command-options.ts`, `output.ts`, `errors.ts` (sysexits mapping),
  `qr-terminal.ts`, `prompts.ts` — the DI/testing patterns here are good; adapt,
  don't discard.
- `src/rpc/client.ts` (task 03) — every command goes through it (auto-spawn applies).

## Scope

1. **Commands**:
   - `keygen [--out <path>] [--force]` — fully non-interactive when `--out` is given
     (v1 was TTY-only and unusable in CI); default output `<state-dir>/key.pem`
     mode `0600`; prints the `sha256/…` pin (and `{ path, pin }` under `--json`);
     refuses to overwrite without `--force`.
   - `link [--ttl <s>] [--qr] [--scheme <s>]` — calls `link.create`, composes
     `<scheme>:///?cordierite=<payload>`; scheme from flag → `config.json` → clear
     error. Human output: link + expiry (+ QR with `--qr`); `--json`:
     `{ sessionId, deepLink, endpoint, expiresAt }`. (`--open` lands in task 07 —
     register the flag now with a "not yet implemented" error so help text is stable.)
   - `ls` — `sessions.list`; table of alias, state, device model/os, tool count, age;
     `--json` passthrough.
   - `tools [selector] [--full]` and `tools [selector] <name>` — list (name +
     description) or detail (schemas + annotations pretty-printed).
   - `invoke [selector] <tool> --input '<json>' [--timeout <ms>]` — result to stdout;
     on error render the **preserved** `error.data.type` prominently, details after.
   - `events [--follow] [selector]` — `events.subscribe` over a persistent stream
     connection; human lines or NDJSON under `--json`; without `--follow`, print
     events until Ctrl-C (same behavior — keep `--follow` as an accepted alias for
     script readability).
   - `revoke [selector]`.
   - `daemon run|start|stop|status` — already exist from task 03; align help text.
2. **Selector handling** — positional optional selector; on `ambiguous_session`
   render the alias list from the error so the user can retry.
3. **`--json` everywhere**, including errors: machine mode must emit a single JSON
   object (or NDJSON stream) on stdout and JSON errors on stderr — the v1 runner
   leaked bare text onto stderr in `--json` mode (`runner.ts:151-154`); fix that in
   the kept runner.
4. **Exit codes** — keep the sysexits mapping in `errors.ts`; map the RPC error
   types onto it (`no_session`/`unknown_session` → not-found class, `policy_denied`
   → permission class, transport/daemon-unreachable → unavailable class). Recreate an
   `exit-codes` test suite for the v2 commands (the v1 suite was deleted with the v1
   commands in task 01 — its convention of asserting exact codes per failure class is
   worth reproducing).

## Out of scope

- `--open` implementations (task 07). MCP (task 08).

## Acceptance criteria

- Command table of §10 works end-to-end against a real daemon in an integration test
  (temp state dir): keygen → daemon auto-spawn via `ls` → link → fake app client
  claims → `ls` shows the alias ACTIVE → `tools`/`invoke` round-trip → `revoke`.
- `keygen --out` works with stdin/stdout not a TTY.
- Every command supports `--json`; `invoke … --json` with a failing tool emits
  parseable JSON whose `error.type` equals the app's wire error type.
- Help output (`--help` per command) matches the §10 table: no missing flags, no
  undocumented flags (v1 shipped an undeclared `--open`; don't repeat that).
- `bun run lint/build/test` green.

## Testing

Reuse the kept test conventions (snapshot output tests in `output.test.ts` style,
DI'd writers/clock). Add: per-command `--json` contract tests, the daemon-backed
integration flow above, exit-code suite, and an `events --json` NDJSON stream test
(spawn the CLI as a subprocess, assert line-delimited parseability).

> Status: DONE. All acceptance criteria verified (see final worker report). One
> deliberate deviation from the literal task text: `keygen`'s v1 interactive TTY
> prompt flow was removed rather than kept as a fallback — ARCHITECTURE.md §10 only
> documents `[--out]`/`[--force]` flags with no interactive mode, and per LOOP.md
> "when your task file and ARCHITECTURE.md disagree, ARCHITECTURE.md wins."
