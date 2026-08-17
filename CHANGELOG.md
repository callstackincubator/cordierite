# Changelog

All notable changes to `cordierite`, `@cordierite/shared`, and `@cordierite/react-native` are
documented here. The three packages are versioned in lockstep (identical version numbers), so one
changelog covers all of them.

This file is maintained by hand. There is no automated changelog tooling (see
`docs/CI.md#release-policy` for why) — update this file as part of the commit that bumps the
package versions for a release.

## Unreleased

- **Fix: release builds no longer carry Cordierite's native module by default.** Previously,
  leaving `CORDIERITE_ENABLED` unset shipped Cordierite in every build variant, including
  release — the opposite of the intended dev-only default. Unset now links only `Debug`/`debug`,
  `1`/`true` links every variant (for a release-signed internal/QA build that still needs
  Cordierite), and `0`/`false` excludes it everywhere, unchanged. iOS: `react-native.config.js`
  sets CocoaPods' `:configurations`, a real per-variant linking decision. Android: RNGP's
  generated `PackageList.java` is shared, unfiltered, across every variant, so the equivalent
  `buildTypes` restriction breaks compilation for a package with static Java registration
  instead — `android/build.gradle` instead swaps which Kotlin source set compiles for `release`
  (the real implementation, or a no-op `CordieritePackage` at the same fully-qualified name),
  keyed on the same `CORDIERITE_ENABLED`. Neither mechanism is a runtime check.
- **Fix: `cordierite doctor`'s Android detection now requires the `CordieriteNativeMarker`
  keep-rule signal to report `present`.** The no-op stub introduced by the fix above compiles at
  the real implementation's exact package name, and the config plugin writes the same
  `AndroidManifest.xml` meta-data regardless of build variant — so the two other Android
  signals (dex package-string, manifest meta-data keys) could otherwise report a harmless
  default-release stub as "present." They're still reported for corroboration but no longer
  independently decide the verdict.
  See `packages/react-native/README.md`'s "Compiling Cordierite out of production builds" for the
  updated matrix.

## Unreleased (0.4.0)

0.4.0 is a rewrite of the CLI/daemon/protocol layer and is expected to contain breaking changes
for anyone on 0.3.x. Highlights since 0.3.1:

- **Breaking: daemon-based architecture ("protocol v2").** The CLI is now a thin RPC client to a
  background daemon process instead of talking to devices directly; the wire protocol, session
  engine, and invocation RPC surface were all rewritten.
- **Breaking: `enableInReleaseBuilds` removed from the React Native config plugin, with no
  deprecation shim.** Passing it at all (`true` or `false`) now throws at prebuild, naming the
  replacement. Whether native code ships is decided by autolinking alone, driven by the
  `CORDIERITE_ENABLED` environment variable: unset or empty means included (so a build that never
  mentions Cordierite still gets it), `0`/`false` opts the package out of autolinking on both
  platforms, and any other value is a config error. The package ships its own
  `react-native.config.js` that reads it, and `@cordierite/react-native/metro` reads the same
  variable to strip the JS, so one pipeline variable removes both surfaces with no app-side config.
  It must be set when autolinking resolves (`pod install` / gradle configure), not merely when the
  app compiles. What a build trusts is decided by `trust` — `"pin"` when `cliPins` is configured,
  `"link"` otherwise (trust the SPKI pin carried by the bootstrap link, per session) — and is no
  longer tied to whether the build is debuggable. A 0.3.x config that set `enableInReleaseBuilds`
  (either value) must simply delete that option; see `packages/react-native/README.md`'s
  "Hardening for production / internal builds" and "Compiling Cordierite out of production builds"
  sections for the full migration.
- **When Cordierite is linked, its podspec and `build.gradle` print `[cordierite] native module
  INCLUDED in this build`** during pod install / gradle configure. Nothing prints when it is
  excluded, because nothing runs — the line exists to catch a release build that carries
  Cordierite by mistake. `cordierite doctor` remains the authority, since it inspects the built
  artifact rather than the build log.
- **New:** `cordierite doctor <artifact>` — inspects a built `.app`/`.ipa`/`.apk`/`.aab` directly
  to assert whether Cordierite is present or absent, replacing the old runtime `debuggable`/`#if
  DEBUG` check as the release-gate mechanism.
- **New:** `cordierite mcp` — an MCP server exposing Cordierite sessions to MCP-compatible tools.
- **New:** emulator/simulator fast path (`cordierite link --open`).
- **New:** session recovery on iOS and Android — the native clients can resume a session across an
  app process restart (resume lease) instead of requiring a fresh bootstrap link.
- **New:** daemon-side policy engine and audit log.
- **Hardened:** iOS and Android native connection layers no longer contain any build-type
  (`debuggable`/`#if DEBUG`) check at all; whether Cordierite's native code is present in a build
  is decided solely by autolinking, independent of debuggability, and is verifiable directly
  against a built artifact with `cordierite doctor`.
- **Tooling:** migrated the workspace from bun to pnpm + vitest; CI now pins all GitHub Actions to
  full commit SHAs and publishes via npm trusted publishing (OIDC + provenance).

This list is a summary, not a full commit log — see `git log` for exact detail.

## 0.3.1 and earlier

Published to npm (0.1.0, 0.2.0, 0.3.0, 0.3.1) but not documented in a changelog. Consult the git
history predating the 0.4.0 rewrite (everything before `task(01): delete v1 host model and fix
repo hygiene`) for what shipped in those releases.
