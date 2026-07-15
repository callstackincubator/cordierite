# 01 — Repo hygiene & v1 demolition

## Goal

Start the refactor with a clean slate: remove the committed trust-anchor key, then
**delete the entire v1 host model** from `packages/cordierite`. Nothing uses this
project yet — the old code is not migrated, deprecated, or kept compiling; it is
removed. What survives is only what v2 reuses.

## Depends on

Nothing. First task.

## Read first

- `docs/ARCHITECTURE.md` §13 (what the v2 package layout keeps), §14.
- `packages/cordierite/src/` — full listing, so you know what you're deleting vs
  keeping.
- `playground/.gitignore`, `playground/certs/`.

## Scope

1. **Committed private key.**
   - Delete `playground/certs/dev-key.pem`.
   - In `playground/.gitignore`, remove the `!certs/dev-key.pem` force-include; keep
     `*.pem` ignored.
   - Replace the matching pin `sha256/aHDJIGvOJjRr3K9qmqmw3FQ6KWx+wWgEpKVLDbxmyhY=`
     wherever it appears in playground config (`playground/ios/playground/Info.plist`
     key `CordieriteCliPins`, `playground/android/app/src/main/AndroidManifest.xml`
     meta-data `com.callstackincubator.cordierite.CLI_PINS`, `playground/app.json`
     `cliPins`) with the placeholder `sha256/REPLACE_WITH_KEYGEN_OUTPUT`.
   - Add a short "Generate your own key" section to `playground/README.md`: run
     `cordierite keygen`, paste the printed pin, never commit `.pem` files. Note that
     the previously committed key must be treated as compromised (history rewrite is
     out of scope for this task).
2. **Delete the v1 host model** in `packages/cordierite/src`:
   - `commands/host.ts`, `commands/connect.ts`, `commands/session.ts`,
     `commands/tools.ts`, `commands/invoke.ts`, `commands/remote-control.ts`,
     `session-registry.ts`, `runtime.ts`, `host-reporters.ts`, `host-events.ts`,
     `tool-registry.ts` (dead stub — imported nowhere; verify with grep first).
   - **Keep** (v2 reuses them): `commands/keygen.ts`, `host-certificate.ts`,
     `spki-pin.ts`, `qr-terminal.ts`, `errors.ts`, `output.ts`, `parse.ts`,
     `prompts.ts`, and the CLI plumbing (`cli/create-cli.ts`, `cli/dispatch.ts`,
     `cli/runner.ts`, `cli/command-options.ts`, `cli/types.ts`, `bin.ts`, `index.ts`).
   - Trim the kept files: remove registrations/dispatch branches for the deleted
     commands (the CLI temporarily exposes **only `keygen`** — that is the intended
     state until tasks 03/06 rebuild the surface), remove dead exports from
     `index.ts`, remove now-unused imports/helpers/options.
   - Tests: delete suites that cover deleted code (`host-reporters.test.ts`, the
     host/session/tools/invoke portions of `cli.integration.test.ts`,
     `command-handlers.test.ts`, `host.test.ts`, `exit-codes.test.ts`, fixtures).
     **Port, don't delete**, the cases that cover kept modules — notably the
     certificate SAN/pin-stability tests (move them next to `host-certificate.ts` /
     `spki-pin.ts` coverage) and keygen/output/QR tests.
3. **Remaining hygiene in kept code.**
   - `cli/runner.ts`: remove the dead `renderedSuccess = true` (~line 112; it is
     unconditionally reassigned a few lines later).
4. **Packaging drift in `packages/react-native`.**
   - `package.json`: add `"prepublishOnly": "bun run clean && bun run build"`.
   - Delete stale generated files under `build/` (both current and legacy
     `cordierite-*` names) — `bun run clean` then rebuild.
   - `app.plugin.js:9`: replace the hardcoded `"0.1.0"` with
     `require("./package.json").version`.
   - `android/build.gradle` (~:35, ~:45): bump the hardcoded `0.1.0` to match
     `package.json`, with a `// keep in sync with package.json` comment.

## Out of scope

- Git history rewrite / key rotation ceremony (document it, don't do it).
- `@cordierite/shared` and `@cordierite/react-native` source changes (task 02 handles
  the protocol replacement; RN still compiles against v1 shared exports until then).
- Building anything new.

## Acceptance criteria

- `git grep -I "aHDJIGvOJjRr3K9qmqmw3FQ6KWx"` returns nothing;
  `git ls-files "*.pem"` is empty.
- None of the deleted files exist; `git grep -l "session-registry\|remote-control\|host-reporters\|host-events"`
  inside `packages/cordierite/src` returns nothing.
- The CLI builds and `cordierite --help` shows only `keygen` (plus help/version).
- Certificate and SPKI-pin test coverage still exists and passes.
- `bun run lint`, `bun run build`, `bun run test` green from the repo root
  (`@cordierite/shared` and `@cordierite/react-native` untouched and green).

## Testing

The deliverable is deletions with the suite green. Every kept module that had
coverage before must still have it after (ported, not weakened).

> Status: DONE. See commit `task(01): ...` on branch `grand-refactor`.
