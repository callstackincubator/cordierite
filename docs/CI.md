## Current state

  CI is implemented with three workflows:

  - `test.yaml` runs JavaScript, Android JVM, and iOS XCTest coverage in parallel; the `android`
    job also runs the `cordierite doctor` release gate (below) against four builds of the
    playground across all three `CORDIERITE_ENABLED` states; the `ios` job runs it against two
    Debug builds (default and `CORDIERITE_ENABLED=0`).
  - `lint.yaml` runs lint and package typecheck in parallel; the playground is intentionally excluded from typecheck.
  - `deploy.yaml` gates a production release on both reusable workflows, packages the three tarballs, and publishes them
    through npm trusted publishing.
  - All third-party actions are pinned to full commit SHAs. Dependency and Turbo caches are disabled.
  - pnpm is resolved via corepack (`corepack enable && corepack prepare --activate`) instead of a separately pinned
    `pnpm/action-setup` version, so the pnpm version used in CI always matches the root `package.json`'s
    `packageManager` field. `actions/setup-node` runs first to put Node/corepack on `PATH`, then corepack activates
    pnpm before any install step.

  Verification found:

  - The JavaScript test suite passes locally.
  - A cache-free, frozen-lockfile installation builds successfully.
  - Packed CLI and React Native tarballs contain an exact `@cordierite/shared` version rather than `workspace:*`.
  - Android JVM tests pass with :cordierite_react-native:testDebugUnitTest; no emulator is required. The TLS pinning cases (`computeSpkiPin`, `PinningTrustManager`) run under Robolectric inside that same task, since both reach `android.util.Base64`; everything else stays on the plain JVM.
  - 18 iOS XCTest cases pass through the generated Cordierite-Unit-Tests scheme.
  - Linting exists for the React Native package and playground. It passes with 10 warnings.
  - Root typecheck, including the CLI and React Native test suites, passes locally.
  - The checked-in playground pin passes Expo plugin configuration validation.
  - main currently has no branch protection.
  - GitHub Actions allows every action, does not require SHA pinning, and gives the default GITHUB_TOKEN write access.
  - No protected npm GitHub environment exists.

## Release gate: `cordierite doctor`

Cordierite's inclusion in a build is controlled entirely by autolinking exclusion (see
[`BUILD-VARIANTS.md`](BUILD-VARIANTS.md)) — there is no runtime `debuggable`/`#if DEBUG`
check to catch a pipeline that forgot to exclude the package
(docs/tasks/00-overview.md, docs/tasks/08-cordierite-doctor.md).

`cordierite doctor <artifact> [--assert-present | --assert-absent]` is the replacement: an
artifact-level assertion you run against the thing you're about to ship, not the config you
think produced it.

```bash
cordierite doctor ./build/MyApp.ipa --assert-absent
cordierite doctor ./build/app-release.apk --assert-absent
```

It inspects a built `.app`/`.ipa`/`.apk`/`.aab` for Cordierite's native code and reports
`present`/`absent`. On iOS it looks for the `RCTNativeCordierite` Objective-C class and the
plugin-authored `Info.plist` keys. On Android the verdict is decided by the
`CordieriteNativeMarker` keep-rule signal alone; the `com.callstackincubator.cordierite`
dex package and the `AndroidManifest.xml` meta-data keys are reported alongside it but
cannot flip it (see [Android detection](#android-detection)).

| Exit code | Meaning |
| --- | --- |
| `0` | inspection succeeded; no assertion was given, or the assertion held |
| `3` | inspection succeeded, but `--assert-present`/`--assert-absent` did not hold |
| `64` | usage error (bad flags, or an artifact extension that isn't `.app`/`.ipa`/`.apk`/`.aab`) |
| `66` | the artifact could not be inspected — a required external tool (`unzip`) was missing, or the artifact was unreadable/corrupt. **Never treated as "absent"**: a broken check must fail loudly, not rubber-stamp a release. |

`66` is always a distinct failure from `3`, and never silently treated as "absent" or "the
check passed".

CI snippet, run against the production release build right before it's distributed:

```yaml
- name: Assert Cordierite is excluded from the production build
  run: npx cordierite doctor ./build/app-release.apk --assert-absent
- name: Assert Cordierite is excluded from the production build (iOS)
  run: npx cordierite doctor ./build/MyApp.ipa --assert-absent
```

For an internally-distributed "testing" build that an agent drives, invert the assertion
(`--assert-present`) so a forgotten inclusion — not just a forgotten exclusion — fails CI
too.

### Android detection

**Android detection is marker-only.** The default release build's no-op
`CordieritePackage` stub necessarily lives at the exact same fully-qualified class name the
real implementation uses (that is what keeps `PackageList.java` compiling — see
[`BUILD-VARIANTS.md`](BUILD-VARIANTS.md#inclusion-is-an-autolinking-decision)), and the
config plugin writes the same `AndroidManifest.xml` meta-data regardless of build variant.
Both would otherwise look like "Cordierite is present" to a naive scan.

`doctor` accounts for this: only the `CordieriteNativeMarker` keep-rule signal decides
`present`/`absent` on Android. The other two signals are still reported for corroboration
but can't flip the verdict on their own.

The three signals, in order of reliability:

1. `CordieriteNativeMarker`, kept unminified by the keep rule `@cordierite/react-native`
   ships via `consumerProguardFiles`. It reaches every consuming app's R8 run without the
   app authoring any rule, so it holds for bare-RN apps that never touch the Expo config
   plugin.
2. The dex package name — survives ordinary minification but not R8 full mode's
   repackaging.
3. The config plugin's `AndroidManifest.xml` meta-data keys — only present if the plugin
   ran.

Signals 2 and 3 are retained as fallbacks for artifacts built before the marker existed.
See `packages/cordierite/src/artifact-inspect.ts`'s file-level comment for the full
detection writeup.

**Verified** against a real R8-minified release APK
(`assembleRelease -Pandroid.enableMinifyInReleaseBuilds=true`): the R8 mapping shows
sibling classes obfuscated (`CordieriteBuildConfig -> …cordierite.a`) while
`CordieriteNativeMarker` keeps its fully-qualified name, and `doctor --assert-present`
passes on that artifact.

**Still not covered:** R8 *full mode* with `-repackageclasses` was not exercised, and no
artifact was tested from a bare-RN app that uses neither Expo nor the config plugin — the
configuration the marker most directly targets. The marker should hold in both (a `-keep`
rule prevents renaming and removal regardless of mode), but that is reasoning, not a
measurement.

### This repo's own CI wiring

**This repo's own CI wires the gate** (`test.yaml`'s `android` job) against all three
`CORDIERITE_ENABLED` states: after the existing `testDebugUnitTest`/`assembleDebug` step (unset
`CORDIERITE_ENABLED`, the default), it asserts `--assert-present` against the debug APK, then
assembles the same android/ directory's **Release** build and asserts `--assert-absent` against
it — proving the dev-only default actually excludes Cordierite from release. It then re-prebuilds
with `CORDIERITE_ENABLED=1`, reassembles Release, and asserts `--assert-present`, proving the
opt-in path back into release works. Finally it re-prebuilds with `CORDIERITE_ENABLED=0`,
reassembles Release, and asserts `--assert-absent` again — the regression test for
`docs/tasks/02-fix-autolinking-exclusion.md`'s original failure mode, that the documented
exclusion recipe had never worked. All four assertions run against a real built artifact each
run, not by inspecting the config.

**The iOS side is wired too** (`test.yaml`'s `ios` job, `docs/tasks/13-ios-ci-doctor-gate.md`):
after the existing `Cordierite-Native-Tests` XCTest run and the normal Debug simulator build
(unset `CORDIERITE_ENABLED`, the default, which links Cordierite in Debug), it asserts
`--assert-present` against that build's `.app`, then re-prebuilds with `CORDIERITE_ENABLED=0`
and rebuilds for the simulator, asserting `--assert-absent`. Excluding the package from iOS
autolinking also disables its codegen, and the playground's `with-native-tests` Expo plugin used to
hand-add the `Cordierite` pod unconditionally for the XCTest target — hand-adding the pod on top of
an exclusion fails to compile, since `RCTNativeCordierite.mm` imports a `CordieriteSpec.h` header
codegen never generates for an excluded module (verified against a real build; see "iOS codegen
coupling" in `docs/ARCHITECTURE.md` §11 and `docs/tasks/00-overview.md`). `with-native-tests.js`
reads the same `CORDIERITE_ENABLED` signal, through `@cordierite/react-native/autolink-env.js`'s
`isCordieriteAutolinkEnabled` — the exact parser `react-native.config.js` itself uses — and skips
adding the pod line when Cordierite is excluded, so the excluded rebuild compiles and produces a
real `.app` for `doctor` to inspect instead of failing outright. The normal, non-excluded `ios` job
still runs the `Cordierite-Native-Tests` XCTest target unchanged. Only the Debug configuration is
exercised on iOS today — Release-configuration coverage for the new dev-only default (mirroring the
Android job's Release legs above) is not wired yet.

CI invokes the command directly against the built artifact — `node packages/cordierite/bin.js
doctor <path> --assert-present|--assert-absent` from the repo root, after `pnpm build` — rather
than through a published `cordierite` binary, matching how the playground's own
`scripts/cordierite.sh` launcher invokes the CLI from a workspace checkout.

## Release policy

Publish production releases only for now. The deployment workflow must reject prerelease versions and publish every
approved release with the `latest` dist-tag. Do not add `next` or `rc` publishing until prereleases are deliberately
supported.

Update `CHANGELOG.md` by hand as part of the commit that bumps the three package versions for a release. There's no
changelog-generation tooling (Changesets was evaluated and rejected for this repo — three packages that always
version in lockstep get little value from a tool built around independent per-package version graphs, and its
standard CI publish flow doesn't compose with this repo's per-package OIDC environment gates below); a short,
hand-written entry per release is proportionate for a single-maintainer repo.

0.1.0 through 0.3.1 were published to npm (confirmed via `npm view <pkg> time`) before `deploy.yaml` existed —
that workflow was only added on 2026-07-17, over three months after the 0.3.1 release commit (`c451163`,
2026-04-08). Those releases were published by hand. **The current `deploy.yaml` OIDC/trusted-publishing pipeline
has not yet been used for a real publish**; the 0.4.0 release will be its first. Treat that as an open risk to
de-risk (e.g. a dry run or careful review of the trusted-publisher configuration) before cutting 0.4.0, not as a
proven path.

 ## Implemented workflows

   Workflow       Trigger                            Jobs
  ━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   test.yaml      PR, push to main, workflow_call    js, android, ios in parallel
  ─────────────  ─────────────────────────────────  ────────────────────────────────────────────────
   lint.yaml      PR, push to main, workflow_call    lint, typecheck in parallel
  ─────────────  ─────────────────────────────────  ────────────────────────────────────────────────
   deploy.yaml    Published GitHub release           quality/test gates, package, OIDC publish jobs

  ### test.yaml

  All jobs should have contents: read, immutable action SHAs, persist-credentials: false, fixed tool versions, timeouts,
  and no restored caches.

  - js on Ubuntu:

    pnpm install --frozen-lockfile --ignore-scripts
    pnpm build -- --cache=local:,remote:
    pnpm test -- --cache=local:,remote:

  - android on Ubuntu with Java 17:

    pnpm install --frozen-lockfile --ignore-scripts
    pnpm build -- --cache=local:,remote:
    cd playground
    pnpm exec expo prebuild --platform android --no-install
    cd android
    ./gradlew \
      :cordierite_react-native:testDebugUnitTest \
      assembleDebug \
      --no-daemon \
      --no-build-cache \
      --no-configuration-cache

    Remove gradle/actions/setup-gradle; the generated wrapper is sufficient.

  - ios on a fixed macOS image:

    pnpm install --frozen-lockfile --ignore-scripts
    pnpm build -- --cache=local:,remote:
    cd playground
    pnpm exec expo prebuild --platform ios
    cd ios
    xcodebuild test \
      -workspace playground.xcworkspace \
      -scheme Cordierite-Unit-Tests \
      -destination 'platform=iOS Simulator,name=iPhone 16' \
      CODE_SIGNING_ALLOWED=NO \
      COMPILER_INDEX_STORE_ENABLE=NO

    Preserve the existing playground simulator build as a second xcodebuild build step so the workflow tests both the
    native library and consumer integration.

  ### lint.yaml

  The root typecheck script and corresponding Turbo task already exist. The CLI, shared package, and React Native
  package must expose dedicated typecheck commands. The playground is intentionally excluded from typecheck.

  The two jobs become:

  pnpm install --frozen-lockfile --ignore-scripts
  pnpm lint -- --cache=local:,remote:

  and:

  pnpm install --frozen-lockfile --ignore-scripts
  pnpm typecheck -- --cache=local:,remote:

  Typecheck must continue to cover tests.

  ### deploy.yaml

  Recommended flow:

  release published
        │
        ├── call lint.yaml
        └── call test.yaml
                 │
                 ▼
         build and create 3 .tgz files
                 │
                 ▼
         publish @cordierite/shared
                 │
            ┌────┴────┐
            ▼         ▼
     publish CLI   publish RN

Important details:

  - Trigger only on release: types: [published].
  - Validate that the release tag is exactly v<package-version>.
  - Require all three package versions to match.
  - Use Node 24/npm 11.5.1 or newer.
  - Build and pack without OIDC privileges.
  - Upload the three .tgz release bundles with a one-day retention period. This is a release artifact, not a dependency/
    build cache.

  - Give id-token: write only to the three small publish jobs.
  - Publish the already-built tarballs; do not checkout code, install dependencies, or execute package scripts in the
    privileged jobs.

  - Publish shared first, then CLI and React Native.
  - Reject prerelease package versions and publish only production releases with
    `npm publish <tarball> --access public --provenance --tag latest`.
  - Never set NODE_AUTH_TOKEN or create an npm write token.
  - Set concurrency: npm-publish with cancel-in-progress: false.

  npm trusted publishing currently requires npm 11.5.1+, Node 22.14+, GitHub-hosted runners, and an exact workflow
  filename. Configure a trusted publisher separately for all three existing npm packages using:

  - Repository: callstackincubator/cordierite
  - Workflow filename: deploy.yaml
  - Environment: npm
  - Allowed operation: npm publish

  Trusted publishing automatically provides short-lived OIDC authentication and provenance; no long-lived npm token is
  necessary. npm trusted publishing documentation (https://docs.npmjs.com/trusted-publishers/)

  ## Repository hardening

  Before enabling deployment:

  - Create an npm GitHub environment.
  - Allow only v* tags to deploy.
  - Require approval, prevent self-approval, and disable administrator bypass.
  - Protect main with required checks for all five test/quality jobs.
  - Require pull request review before merge.
  - Set default workflow permissions to read-only and disallow Actions from approving PRs.
  - Require every action to be pinned to a full commit SHA and restrict allowed actions. Full commit SHAs are the
    required form in every workflow; moving tags such as `@v4` are not acceptable.
  - Protect release tags.

  GitHub states that full-length commit SHA pinning is the only immutable way to reference an action. GitHub secure-use
  guidance (https://docs.github.com/en/actions/reference/security/secure-use) Environment protections can enforce
  reviewers and tag restrictions before a publishing job starts. GitHub environment documentation
  (https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

  Finally, disabling caches addresses cache poisoning, but it is only one part of supply-chain security. The lockfile,
  ignored lifecycle scripts, immutable actions, protected release environment, npm provenance, and native dependency
  verification are at least as important.
