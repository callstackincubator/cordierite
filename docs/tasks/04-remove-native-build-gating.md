# 04 — Remove native build-time gating

**Wave 1. Depends on 01. Runs in parallel with 05 — verify the file split below holds before
starting both.**

## Goal

No native code decides whether Cordierite should exist. Autolinking decides, at the app
level, in one place.

## Why

The current design has the module unregistered-but-present on Android and compiled-out on
iOS, described in the docs as if they were equivalent. Autolinking exclusion removes native
code on both, which is both the stronger guarantee and the only one we can state honestly
for both platforms. Everything below exists only to approximate it per-platform.

The iOS half is also the most fragile code in the package: it string-matches
`post_install do |installer|` in a *generated* Podfile, injects Ruby that mutates two build
settings with separate String-vs-Array normalization branches, and has to interleave with
anything else patching that file — `playground/plugins/with-native-tests.js` already does.
It additionally injects *before* `react_native_post_install`, which mutates pod build
settings itself.

## Scope — delete

**Android** (`packages/react-native/android/src/main/java/.../CordieritePackage.kt`):

- the `FLAG_DEBUGGABLE` check, `ENABLE_IN_RELEASE_KEY`, `parseEnableInRelease`,
  `isCordieriteRegistrationEnabled`, and `readApplicationInfo` if nothing else needs it.
- `getModule` returns the module unconditionally for the matching name.
- Drop the corresponding cases in `android/src/test/java/.../CordieritePackageTest.kt`.

**iOS**:

- `ios/CordieriteTurboBridge.swift` and `ios/RCTNativeCordierite.mm`: remove the
  `#if DEBUG || CORDIERITE_ENABLE_RELEASE` wrappers and their explanatory comments.
- `Cordierite.podspec`: remove the `CORDIERITE_ENABLE_RELEASE` comment block.

**Plugin** (`packages/react-native/app.plugin.js`) — the Podfile half only; the rest is
task 06:

- `withPodfile` mod, `addEnableInReleaseFlagToPodfile`, `ENABLE_IN_RELEASE_PODFILE_MARKER`,
  and their `__internal` exports and tests in `src/__tests__/app-plugin.test.ts`.

## Keep

- JS `noopIfNativeUnavailable` in `src/index.ts` and the `/noop` entry. With the pod or
  Gradle module excluded, `TurboModuleRegistry` still comes back empty and JS still needs to
  degrade — this is now the *only* runtime absence path, so its tests matter more, not less.

## Watch for

- Android: with `getModule` no longer returning `null`, confirm nothing else relied on that
  path (the `getReactModuleInfoProvider` asymmetry the old comment described disappears).
- iOS: removing the `#if` changes what compiles in Release for the first time. Build the
  playground in Release and confirm the pod compiles clean under
  `-strict-concurrency=complete`, which the gated code has never been exercised against in
  that configuration.

## Acceptance

- `git grep -n "CORDIERITE_ENABLE_RELEASE\|ENABLE_IN_RELEASE"` returns nothing in native
  source or the Podfile mod. **Corrected after the fact:** this task cannot clear the name
  repo-wide, because `app.plugin.js` still writes the `ENABLE_IN_RELEASE` meta-data from the
  `enableInReleaseBuilds` option, and that option belongs to task 06. Between 04 and 06 the
  plugin therefore writes a manifest key no native code reads — dead but harmless. Task 06
  closes it; task 09 clears the docs.
- A generated Podfile after prebuild contains no Cordierite `post_install` block.
- Playground builds and connects in **Release** on both platforms with the package
  autolinked, and neither builds nor exposes a module when excluded (task 08 gives you the
  artifact-level check for the second half).
