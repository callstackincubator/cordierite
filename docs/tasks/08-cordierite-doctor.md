# 08 — `cordierite doctor`: artifact-level inclusion check

**Wave 1. Depends on 01. Independent of every other task — no shared files.**

## Goal

A release pipeline can prove that a built `.app`/`.ipa`/`.apk`/`.aab` does or does not
contain Cordierite native code, and fail the build if it's wrong.

## Why

This is not a nice-to-have; it is the replacement for something we are removing. Today, a
production pipeline that forgets the autolinking exclude is caught by the `debuggable`
check at runtime. After task 04, nothing catches it — the safety net becomes "did CI get the
config right", which is precisely the class of mistake that produced the silent no-op in
task 02.

An artifact-level assertion is strictly better than the runtime check it replaces: it runs
in CI, before distribution, and it inspects the thing you are actually shipping rather than
the config you think produced it.

## Scope

```
cordierite doctor <path-to-artifact> [--assert-absent | --assert-present] [--json]
```

- Accept `.app`, `.ipa`, `.apk`, `.aab`. Report per-platform: Cordierite native code
  present/absent, and — when present and cheaply readable — the configured trust mode from
  `Info.plist` / the manifest.
- Detection: the Objective-C class name (`RCTNativeCordierite`) and the Swift/pod symbols on
  iOS; the `com.callstackincubator.cordierite` package/classes in the dex on Android. Prefer
  tools already available where the artifact is built (`unzip`, `strings`, `nm`,
  `aapt2`/`dexdump`) and degrade with a clear message rather than a wrong answer when a tool
  is missing. **Never report "absent" because a tool was unavailable** — that failure mode
  turns the safety net into a rubber stamp; exit non-zero and say which tool was missing.
- Exit codes: `0` when the assertion holds, non-zero when violated, distinct non-zero when
  the artifact could not be inspected. `--json` for machine consumption, consistent with
  the CLI's existing `--json` conventions.
- Follow the existing CLI patterns: `src/commands/`, the DI/testability approach in
  `src/cli/`, and the renderers in `src/output.ts`.

## Out of scope

Inspecting the JS bundle for the Cordierite JS half. Worth doing eventually — the Metro swap
is unverified too — but keep this task to native inclusion.

## Acceptance

- Fixture artifacts (built once, committed small or generated in CI) for both platforms,
  both included and excluded, with tests over all four.
- A missing external tool produces a distinct exit code and message, and is covered by a
  test.
- Documented in `packages/cordierite/README.md` and `docs/CI.md` as a **release-gate step**,
  with a copy-pasteable CI snippet.
- Task 09 wires it into this repo's own CI against the playground's Release build.
