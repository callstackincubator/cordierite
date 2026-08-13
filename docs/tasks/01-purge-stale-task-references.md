# 01 — Purge stale task references

**Wave 0. Must land before every other task in this directory, on its own.**

## Goal

Every `docs/tasks/...` reference in the codebase points at a file that exists, or is gone.

## Why

`git grep -nE "docs/tasks|design doc part B|task [0-9]" -- packages playground` returns ~71
hits across 37 files, pointing at `docs/tasks/00-overview.md`,
`docs/tasks/01-ios-debug-flag-spike.md`, and bare numbered tasks from a planning series that
was never committed. This series reuses those exact filenames, so leaving them would make
every stale pointer silently resolve to an unrelated document.

The cost of not doing this is already visible: `app.plugin.js` opens with a seven-line
comment explaining that the *other* comments' task numbers are untrustworthy. A comment
about the unreliability of comments is a signal to delete the layer, not annotate it.

It lands alone because it touches 37 files across all three packages and would conflict with
everything in wave 1.

## Scope

- Rewrite each reference to state the reasoning inline, or delete it when the surrounding
  code already says it. Prefer deletion — most of these are provenance notes ("task 09 said
  to do this"), not explanations.
- Delete the disclaimer comment at the top of `packages/react-native/app.plugin.js`.
- Keep genuine cross-references to `docs/ARCHITECTURE.md` / `docs/PROTOCOL.md` /
  `docs/SECURITY.md` — those files exist.
- New references to files in this series are allowed once this task has landed.

## Out of scope

Behavior changes of any kind. This is a comment-only commit; the diff should contain no
executable lines.

## Acceptance

- `git grep -nE "docs/tasks/(00|01)-|design doc part B|task [0-9]+" -- packages playground`
  returns nothing that points at a non-existent file.
- Test suites unchanged and green (no logic touched).
- Diff is comments only — verify with a review pass, not just a green build.
