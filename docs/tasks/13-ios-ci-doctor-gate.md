# 13 — Wire the iOS half of the CI doctor gate

**Depends on 08, 09, 10 (all merged). No parallel siblings.**

## Goal

CI proves, on iOS as it already does on Android, that a build with Cordierite excluded from
autolinking really ships without it — `cordierite doctor --assert-absent` against a real
`.app`.

## Why it was left open

Task 09 wired `doctor` into the Android CI job only. The iOS side was blocked by a coupling
task 02 discovered: excluding the package from autolinking on iOS also stops its **codegen**,
and `playground/plugins/with-native-tests.js` hand-adds the Cordierite pod for the XCTest
target. That pod's `RCTNativeCordierite.mm` imports the generated `CordieriteSpec.h`, so an
excluded iOS build fails to compile rather than producing an artifact to inspect.

So the gate is missing on exactly the platform where the strip is hardest to reason about,
and the asymmetry is currently invisible in CI — it just looks like Android is covered.

## Scope

- Make `playground/plugins/with-native-tests.js` skip its `pod` line when the package is
  excluded, driven by the same signal CI uses for the exclude. Hand-adding a pod for a
  package you just excluded is incoherent; the plugin should recognise that.
- Add the iOS leg to the CI workflow: prebuild + build with the exclude applied, then
  `doctor --assert-absent` on the resulting `.app`. Keep the existing
  `--assert-present` leg for the normal build.
- Confirm `doctor`'s iOS detection reports **absent** correctly for a genuinely excluded
  build — that is the assertion, and it has never been run against a real excluded `.app`.

## Watch for

- The exclude must live in `package.json`'s `expo.autolinking`, never `app.json` — see
  task 02. If CI mutates config to produce the excluded build, drop the Cordierite config
  plugin entry too: it unconditionally writes `Info.plist` keys that `artifact-inspect.ts`
  reads as a presence signal, which would make `--assert-absent` fail for the wrong reason.
  Task 09 hit exactly this on Android.
- `expo.autolinking.apple` takes priority over `ios` — an `apple` block, if present, wins
  outright.
- iOS builds are slow. Commit your workflow and plugin changes **before** attempting a full
  build, so a stalled build doesn't cost the work.

## Acceptance

- CI has both legs on iOS, and the `--assert-absent` leg genuinely passes against an excluded
  build (not skipped, not `continue-on-error`).
- The XCTest target still runs in the normal, non-excluded CI job.
- `docs/CI.md`'s note that the iOS gate is unwired is removed only once it actually is.
- If you cannot run the iOS build in this environment, say so prominently — a workflow that
  has never executed is exactly the failure mode this series keeps hitting.
