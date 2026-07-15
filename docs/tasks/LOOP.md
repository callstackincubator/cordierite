# LOOP.md — Worker instructions

You are a worker agent implementing one task of the Cordierite v2 refactor. The
orchestrator gives you exactly one task file from `docs/tasks/NN-*.md`. Your job is to
implement that task completely, verify it, self-review it, and land it as a single
commit. You do not pick tasks, reorder them, or start the next one.

## Ground rules

- `docs/ARCHITECTURE.md` is the specification. When your task file and ARCHITECTURE.md
  disagree, ARCHITECTURE.md wins. When the existing code and ARCHITECTURE.md disagree,
  ARCHITECTURE.md wins — that's the point of the refactor.
- Stay inside your task's **Scope**. Its **Out of scope** list names work that belongs
  to other tasks — leaving it undone is correct, not an oversight. If you find a bug
  outside your scope, note it in your final report; do not fix it unless your task's
  tests cannot pass otherwise (then fix minimally and say so).
- Never modify: `docs/ARCHITECTURE.md`, other task files, `docs/IDEAS.md`. You may
  append a `> Status:` line to **your own** task file at the end.
- Breaking changes are allowed project-wide (pre-1.0, zero users), but only the ones
  your task calls for.
- No placeholder implementations: no `TODO: implement`, no stubbed functions returning
  fake data, no skipped tests (`test.skip`) to get green. If you cannot complete an
  item, stop and report BLOCKED (see below) rather than faking it.
- Real secrets never enter the repo: test keys are generated at test runtime into temp
  dirs, never committed. `git ls-files "*.pem"` must stay empty.

## Environment

- Monorepo: bun workspaces + turbo. Node ≥ 20 semantics; runtime for tests is bun.
- Commands (from repo root): `bun install`, `bun run build`, `bun run test`,
  `bun run lint`, `bun run clean`. Per-package: `cd packages/<name> && bun test`.
- Tests use `bun test` (Jest-like API). Follow the existing patterns in
  `packages/cordierite/src/__tests__/` (dependency injection: clock, writers, spawn
  functions) and `packages/react-native/src/__tests__/` (mocked native module).
- Daemon-related tests must set `CORDIERITE_STATE_DIR` to a fresh temp directory per
  test and clean up spawned processes in `afterEach` — a leaked daemon will poison
  later tests and later tasks.

## Procedure

1. **Orient.** Read `docs/ARCHITECTURE.md` in full. Read your task file in full,
   including *Read first*, *Implementation notes*, and *Acceptance criteria*. Read
   every file the task lists under *Read first* before writing anything.
2. **Check dependencies.** The task's *Depends on* lists prior task numbers. Confirm
   they landed: `git log --oneline` (commits are prefixed `task(NN):`, see below) and
   spot-check that the interfaces you need actually exist in the code. If a
   dependency is missing, report BLOCKED immediately — do not implement around it.
3. **Baseline.** Run `bun install && bun run build && bun run test && bun run lint`
   before changing anything. If the baseline is already red, report BLOCKED with the
   failure — do not fix other tasks' breakage silently.
4. **Plan briefly, then implement.** Work in small increments; keep the build green
   as you go. Match the surrounding code's style, naming, and error-handling
   conventions. New modules follow the package layout in ARCHITECTURE.md §13.
5. **Write the tests your task specifies.** The *Acceptance criteria* and *Testing*
   sections are the definition of done — implement every listed case. Prefer
   integration tests over mocks where the task says so; use event subscriptions
   rather than sleeps for synchronization (flaky tests will be treated as failures).
6. **Verify.** From the repo root: `bun run clean && bun run build && bun run test
   && bun run lint` — all green. Then walk the task's *Acceptance criteria* one by
   one and check each explicitly (including the `git grep` sweeps some tasks
   specify). Where a criterion requires a manual run (simulator/emulator smokes) and
   you cannot perform it, mark it "not verified — needs manual run" in your report
   instead of claiming it.

## Self-review (mandatory, before committing)

Re-read your full diff (`git diff` + `git status`) as a skeptical reviewer:

- Scope: does every hunk serve this task? Revert drive-by edits.
- Leftovers: debug logging, commented-out code, unused imports/deps, accidental
  formatting churn in untouched files.
- Robustness: every socket/stream/EventEmitter you created has an `error` handler;
  every timer you created is cleared on all exit paths; every promise is awaited or
  has a rejection handler; every buffer/JSON parse of external input is guarded.
  (v1 died from exactly these — reviewers will look here first.)
- Untrusted input: anything arriving over a socket is validated with the shared
  guards before field access.
- Tests: do they assert behavior (messages on the wire, files on disk, exit codes),
  or just that mocks were called? Strengthen the weak ones.
- Docs: if you changed a public API or CLI flag, is its doc comment/help text
  updated?

Fix what you find, re-run the full verification, then commit.

## Commit

- Exactly **one** commit for the task (squash your increments).
- Message format:

  ```
  task(NN): <imperative summary, e.g. "implement daemon session engine">

  <2-6 lines: what was built, key decisions, anything not verified and why,
  out-of-scope bugs noticed (file:line, one line each).>
  ```

- Never commit: `node_modules`, `dist/`, `build/`, `.turbo/`, temp state dirs, `.pem`
  files, editor droppings. Check `git status` before staging; stage files explicitly
  (no blanket `git add -A` without reading the status output).
- Do **not** push, tag, or open PRs. Do not amend or revert other tasks' commits.

## If blocked

Do not commit partial work. Leave the tree clean (`git stash` or revert), then report:

```
BLOCKED: task NN
Reason: <one paragraph — missing dependency / spec conflict / environment failure>
Evidence: <command output or file:line>
Proposal: <what would unblock — e.g. "task 05 must land first" or a spec decision>
```

A spec conflict between your task file and ARCHITECTURE.md that materially changes
the work is a valid BLOCKED reason — flag it rather than guessing.

## Final report

End with a short report the orchestrator can act on: task number, DONE or BLOCKED,
commit sha (if done), acceptance criteria checklist with pass/fail/not-verified per
item, and any out-of-scope findings.
