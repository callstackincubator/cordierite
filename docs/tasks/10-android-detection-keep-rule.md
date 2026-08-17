# 10 — Make Android detection survive R8

**Wave 3 (with 09). Depends on 08. Owns `packages/react-native/android/` build config and
the Android half of `packages/cordierite/src/artifact-inspect.ts`.**

## Goal

`cordierite doctor --assert-absent` cannot be defeated by minification.

## Why

Task 08 shipped two Android signals: the `com.callstackincubator.cordierite` package string in
the dex, and the plugin-authored manifest meta-data. Its reviewer found a combination that
evades both — **bare RN + R8 with no keep rule and no config plugin** — because R8 can rename
the dex package and there are no plugin-written manifest keys to fall back on.

That is precisely the fail-open the task forbade: `doctor` reports absent, the release gate
goes green, and Cordierite ships. It matters more than a normal detection gap because this
command is the *replacement* for the runtime `debuggable` check that task 04 deleted. A
release gate that can silently pass is worse than no gate, because it is trusted.

The task 08 worker could not fix it without editing `packages/react-native/`, which was
another agent's territory at the time. It documented the gap loudly instead — the right call
then, and this task closes it.

## Scope

- Ship an unminifiable marker with the Android library. The standard mechanism is
  `consumerProguardFiles` in `packages/react-native/android/build.gradle` plus a
  `consumer-rules.pro` that keeps a stable, uniquely-named symbol. Keep the kept surface as
  small as possible — one marker class or one field, not the whole package.
- Update `artifact-inspect.ts`'s Android detection to look for that marker as the primary
  signal, keeping the existing two as fallbacks for older builds.
- Verify against a genuinely minified artifact — a playground Release build with R8 enabled,
  not a synthetic fixture. This task exists because of a minification behavior, so a
  synthetic fixture cannot validate it.

## Also in scope, if cheap

Task 08 deferred the trust-mode readout from `Info.plist` / the manifest rather than ship an
unreliable one. With task 06 landed, those keys are stable and well-defined, so reconsider —
`doctor` reporting `include: yes, trust: pin` is substantially more useful in a release gate
than a bare present/absent. Ship it only if it can be read reliably; a wrong readout in a
release gate is worse than no readout.

## Acceptance

- A minified (R8-enabled) Release APK with Cordierite linked is reported **present**.
- The same build with the package excluded from autolinking is reported **absent**.
- Both cases exercised against real artifacts, and the fixture set in
  `__tests__/artifact-fixtures.ts` notes which cases are real versus synthetic.
- The README's disclosure of the R8 gap is removed only once it is actually closed.
