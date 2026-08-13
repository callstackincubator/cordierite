## Current state

  CI is implemented with three workflows:

  - `test.yaml` runs JavaScript, Android JVM, and iOS XCTest coverage in parallel; the `android`
    job also runs the `cordierite doctor` release gate (below) against two Android Release
    builds of the playground, one with Cordierite included and one with it excluded.
  - `lint.yaml` runs lint and package typecheck in parallel; the playground is intentionally excluded from typecheck.
  - `deploy.yaml` gates a production release on both reusable workflows, packages the three tarballs, and publishes them
    through npm trusted publishing.
  - All third-party actions are pinned to full commit SHAs. Dependency and Turbo caches are disabled.

  Verification found:

  - The JavaScript test suite passes locally.
  - A cache-free, frozen-lockfile installation builds successfully.
  - Packed CLI and React Native tarballs contain an exact `@cordierite/shared` version rather than `workspace:*`.
  - Android JVM tests pass with :cordierite_react-native:testDebugUnitTest; no emulator is required.
  - 18 iOS XCTest cases pass through the generated Cordierite-Unit-Tests scheme.
  - Linting exists for the React Native package and playground. It passes with 10 warnings.
  - Root typecheck, including the CLI and React Native test suites, passes locally.
  - The checked-in playground pin passes Expo plugin configuration validation.
  - main currently has no branch protection.
  - GitHub Actions allows every action, does not require SHA pinning, and gives the default GITHUB_TOKEN write access.
  - No protected npm GitHub environment exists.

## Release gate: `cordierite doctor`

Opt-in hardening removes the runtime `debuggable`/`#if DEBUG` check that used to catch a
production build that forgot to exclude Cordierite via autolinking (docs/tasks/00-overview.md,
docs/tasks/08-cordierite-doctor.md). `cordierite doctor <artifact> [--assert-present |
--assert-absent]` (packages/cordierite/README.md, "Release gate") is the replacement: it inspects
a built `.app`/`.ipa`/`.apk`/`.aab` directly, rather than trusting the config that's supposed to
have produced it, and exits non-zero when the assertion fails.

  - `0`: the artifact matches the asserted expectation (or no assertion was given).
  - `3`: inspection succeeded, but the artifact didn't match `--assert-present`/`--assert-absent`.
  - `66`: the artifact could not be inspected at all (missing `unzip`, unreadable/corrupt
    artifact) — always a distinct failure from `3`, and never silently treated as "absent" or "the
    check passed".

CI snippet, run against the production release build right before it's distributed:

```yaml
- name: Assert Cordierite is excluded from the production build
  run: npx cordierite doctor ./build/app-release.apk --assert-absent
- name: Assert Cordierite is excluded from the production build (iOS)
  run: npx cordierite doctor ./build/MyApp.ipa --assert-absent
```

**This repo's own CI wires the gate** (`test.yaml`'s `android` job): after the existing
`testDebugUnitTest`/`assembleDebug` step, it assembles the playground's Android **Release**
build with Cordierite included (the default) and asserts `--assert-present` against the
resulting APK; it then applies the documented `package.json` autolinking-exclude recipe and
drops the `@cordierite/react-native` config plugin entry from `app.json` entirely (matching the
README's own "skip this whole plugin entry" guidance for a build that shouldn't carry Cordierite
at all — this also avoids the plugin writing `CLI_PINS`/`TRUST` manifest meta-data that
`artifact-inspect.ts` would otherwise read as an inclusion signal even with the native module
correctly excluded), re-prebuilds and reassembles Release, and asserts `--assert-absent`. This is
the regression test for `docs/tasks/02-fix-autolinking-exclusion.md`'s original failure mode —
the documented exclusion recipe had never worked — verified against a real built artifact each
run, not by inspecting the config. The `package.json`/`app.json` mutation happens in the CI job
only and is never committed.

The equivalent iOS wiring is not yet automated: the playground's `with-native-tests` Expo plugin
hand-adds the `Cordierite` pod (for the XCTest target `test.yaml`'s `ios` job already runs), and
excluding the package from iOS autolinking also disables its codegen — hand-adding the pod on top
of that exclusion fails to compile (see "iOS codegen coupling" in `docs/ARCHITECTURE.md` §11 and
`docs/tasks/00-overview.md`). Testing the iOS exclude recipe against a real build would need a
build target that doesn't hand-add the pod, which the current playground doesn't have. The iOS
`ios`/`apple` resolution logic and the bare-RN `react-native.config.js` recipe are covered by unit
tests (`packages/react-native/src/__tests__/app-plugin.test.ts`), not by an artifact-level check,
until that gap is closed.

CI invokes the command directly against the built artifact — `node packages/cordierite/bin.js
doctor <path> --assert-present|--assert-absent` from the repo root, after `pnpm build` — rather
than through a published `cordierite` binary, matching how the playground's own
`scripts/cordierite.sh` launcher invokes the CLI from a workspace checkout.

## Release policy

Publish production releases only for now. The deployment workflow must reject prerelease versions and publish every
approved release with the `latest` dist-tag. Do not add `next` or `rc` publishing until prereleases are deliberately
supported.

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
