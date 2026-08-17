## Current state

  CI is implemented with three workflows:

  - `test.yaml` runs JavaScript, Android JVM, and iOS XCTest coverage in parallel.
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
  - Android JVM tests pass with :cordierite_react-native:testDebugUnitTest; no emulator is required.
  - 18 iOS XCTest cases pass through the generated Cordierite-Unit-Tests scheme.
  - Linting exists for the React Native package and playground. It passes with 10 warnings.
  - Root typecheck, including the CLI and React Native test suites, passes locally.
  - The checked-in playground pin passes Expo plugin configuration validation.
  - main currently has no branch protection.
  - GitHub Actions allows every action, does not require SHA pinning, and gives the default GITHUB_TOKEN write access.
  - No protected npm GitHub environment exists.

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
