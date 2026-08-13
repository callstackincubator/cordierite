# Overview: autolinking-gated inclusion + explicit trust

This directory holds the task breakdown for replacing the current "default-inert release
builds" design with a simpler one:

- **Whether Cordierite is in the build** is decided by **autolinking**, in one place, by the
  app author. No build-type detection anywhere in native code.
- **What the client trusts** is decided by an explicit `trust` config value, not derived from
  whether the build happens to be debuggable.

Read this file before starting any task in this directory — the contract below is what makes
the tasks parallelizable.

## Note on the old task numbering

Comments across ~37 files reference `docs/tasks/00-overview.md`,
`docs/tasks/01-ios-debug-flag-spike.md`, "opt-in hardening design doc part B", and bare task
numbers. Those files were never committed, and the numbers collide with this series. Task 01
strips every one of those references and **must land before anything else**, so that a
reference to `docs/tasks/NN-*.md` in this repo means a file that exists.

## Motivating problems

1. **The gate is keyed on the wrong axis.** `debuggable`/`#if DEBUG` splits builds into
   debug and everything-else. The real axis is the distribution channel, and the "testing"
   variant an agent drives in CI — release-signed, internally distributed — falls into the
   production bucket. It therefore needs `cliPins` baked in at build time, per daemon key,
   which forces either one shared key across CI runners (contradicting `SECURITY.md`'s
   one-key-per-machine rule) or a rebuild per runner. Neither works.
2. **Five overlapping off-switches** across three build stages: Android manifest meta-data +
   runtime check, iOS preprocessor/Swift-condition pair injected by patching the generated
   Podfile, JS degrade-to-noop, the `/noop` entry + Metro swap, and autolinking exclusion.
3. **The platforms don't actually match.** Android ships the code and skips registration;
   iOS compiles it out. Docs describe them as equivalent.
4. **The documented exclusion recipe does not work** (verified — see task 02).

## The contract

Everything below is fixed. Tasks may not change these names unilaterally; if a task needs a
change, update this file first so parallel work sees it.

### Inclusion — the only mechanism

Expo (`package.json`, **not** `app.json`):

```json
{ "expo": { "autolinking": { "ios": { "exclude": ["@cordierite/react-native"] },
                             "android": { "exclude": ["@cordierite/react-native"] } } } }
```

Bare RN (`react-native.config.js` at the app root):

```js
module.exports = {
  dependencies: { "@cordierite/react-native": { platforms: { ios: null, android: null } } },
};
```

This is per-prebuild / per-`pod install`, **not** per build variant. Teams flip it from an
env var in `app.config.ts`. This is a supported-workflow statement, documented as such.

### Plugin option surface

```json
["@cordierite/react-native", {
  "include": true,
  "trust": "pin",
  "cliPins": ["sha256/..."],
  "allowPrivateLanOnly": true
}]
```

- `include` is **declared intent, not a mechanism**. A config plugin cannot control
  autolinking: `expo-modules-autolinking` re-reads `package.json` from disk in a separate
  process at pod-install/gradle time, so a plugin's in-memory mutation never reaches it. The
  plugin therefore *asserts* that the declaration and the real autolinking config agree, and
  fails prebuild with a copy-pasteable fix when they don't. Default `true`.
- `trust`: `"link"` (trust the SPKI pin carried by the bootstrap link, for that session only)
  or `"pin"` (embedded `cliPins` only). Default: `"link"` when `cliPins` is absent, `"pin"`
  when present. `trust: "pin"` with empty/missing `cliPins` is a config-time error.
  `"link"` is TOFU-per-session with real SPKI matching — never "verification disabled".

**Amended during task 05**, implemented on both platforms; downstream tasks must honour it.
`null` and `""` normalize identically *inside* `resolveTrustedPins` rather than at each call
site, so the platforms cannot drift. Any other unrecognized value — `"PIN"`, `"pinn"` — is a
hard error, not a fallback to the default: a typo must never silently downgrade an intended
`"pin"` config into permissive link TOFU. Task 06 should also reject bad values at config
time, making the native error a second line of defence rather than the only one.

**Discovered during task 02:** excluding a module from autolinking on iOS also stops its
**codegen** from running, so an app that excludes the package but still references the pod by
hand (as the playground does for its XCTest target) will fail to compile — `RCTNativeCordierite.mm`
imports the generated `CordieriteSpec.h`. Normal consumers are unaffected, since excluding and
hand-adding the pod is a combination only a maintainer would use. Task 09 should document it.

### Native config keys the plugin writes

| Platform | Key | Value |
| --- | --- | --- |
| iOS `Info.plist` | `CordieriteCliPins` | array of `sha256/...` |
| iOS `Info.plist` | `CordieriteTrust` | `"link"` \| `"pin"` |
| iOS `Info.plist` | `CordieriteAllowPrivateLanOnly` | Boolean |
| Android meta-data | `com.callstackincubator.cordierite.CLI_PINS` | JSON array string |
| Android meta-data | `com.callstackincubator.cordierite.TRUST` | `"link"` \| `"pin"` |
| Android meta-data | `com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY` | Boolean |

### Deleted outright

`enableInReleaseBuilds` (plugin option), `ENABLE_IN_RELEASE` (manifest meta-data),
`CORDIERITE_ENABLE_RELEASE` (Swift compilation condition + `GCC_PREPROCESSOR_DEFINITIONS`
macro), the Podfile `post_install` injection and its marker, `#if DEBUG ||
CORDIERITE_ENABLE_RELEASE` in both iOS files, `parseEnableInRelease`,
`isCordieriteRegistrationEnabled`, and every `isDebugBuild`/`FLAG_DEBUGGABLE` term in trust
resolution.

None of this has ever been published — npm's latest is `0.3.1`, this branch is
`0.4.0-rc.1` — so removal needs no deprecation shim.

### Retained

- JS `noopIfNativeUnavailable` + the `/noop` entry + the Metro `resolveRequest` swap. These
  are the **JS** half of stripping; autolinking exclusion does not touch the bundle. One
  mechanism per layer, instead of five overlapping ones.
- Daemon-side policy and audit — reclassified in the docs as operator ergonomics, not a
  production control, since they run on the machine `SECURITY.md` names as the trust
  boundary. The app-side control is which tools get registered (task 03).

### What we give up, deliberately

Removing the build-type gate means a production pipeline that forgets the autolinking
exclude ships a working Cordierite, where today the `debuggable` check would have caught it.
Task 08 (`cordierite doctor`) is the replacement: an artifact-level assertion you can run as
a release gate. It is not optional to this design.

## Task list and ordering

| # | Task | Depends on |
| --- | --- | --- |
| 01 | Purge stale task references | — (must land first, alone) |
| 02 | Fix autolinking exclusion (docs + playground) | 01 |
| 03 | `useCordieriteTool({ enabled })` | 01 |
| 04 | Remove native build-time gating | 01 |
| 05 | Explicit trust mode in native clients | 01 |
| 06 | Config plugin rewrite | 04, 05 |
| 07 | Native module constants → JS | 05 |
| 08 | `cordierite doctor` artifact check | 01 |
| 09 | Docs, migration, CI | all |

**Parallelization:**

- **Wave 0 (alone):** 01. It edits comments in ~37 files; landing it concurrently with
  anything else guarantees conflicts.
- **Wave 1 (parallel, no shared files):** 02, 03, 04, 05, 08. Task 04 touches
  `CordieritePackage.kt`, the two iOS entry files, and the podspec; task 05 touches
  `CordieriteConnectionManager.{kt,swift}`. Verify that split holds before starting both.
- **Wave 2 (parallel):** 06 and 07, once the key names in 04/05 are real rather than
  contract-only.
- **Wave 3:** 09, last, once behavior is settled.
