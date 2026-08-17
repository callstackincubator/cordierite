# 06 — Config plugin rewrite

**Wave 2. Depends on 04 (Podfile mod removed) and 05 (native keys real). Parallel with 07.**

## Goal

The plugin writes the new keys, and — critically — verifies that what the app *declared*
matches what autolinking will actually do.

## Why

`include` cannot be a mechanism. `expo-modules-autolinking` re-reads `package.json` from
disk in a separate process at pod-install/gradle time, so a plugin's in-memory config
mutation never reaches it. A plugin option that looked authoritative and did nothing is
exactly the failure the playground is already in (task 02).

So the plugin declares intent and *asserts* the mechanism agrees. That gets one property in
one place without lying about where the switch lives — and it catches the silent-no-op class
of bug at prebuild instead of at runtime on a device.

## Scope

**New options** (see `00-overview.md` for the full contract):

- `include: boolean`, default `true` — assertion only, never a mutation.
- `trust: "link" | "pin"`, default `"pin"` when `cliPins` is present, `"link"` otherwise.
- `cliPins`, `allowPrivateLanOnly` — unchanged.
- `enableInReleaseBuilds` — **removed**, not deprecated. Remove the
  `ANDROID_ENABLE_IN_RELEASE_KEY` meta-data write with it: task 04 deleted the native reader,
  so between 04 and this task the plugin writes a manifest key nothing consumes. Verify
  `git grep "ENABLE_IN_RELEASE"` is clean outside `docs/` when you are done. It has never been published (npm
  latest is `0.3.1`; this branch is `0.4.0-rc.1`), so no shim is warranted. Throw a clear
  error naming its replacement if someone passes it, since it exists in this branch's docs
  and in anyone's `rc` checkout.

**Assertion.** Resolve the app's effective autolinking exclude list — `package.json`'s
`expo.autolinking` (root, `ios`, `android`, merged the way `parsePackageJsonOptions` merges
them: platform overrides root) and, for bare-RN projects, `react-native.config.js` — then:

- `include: true` but the package is excluded → throw, naming the file and key to remove.
- `include: false` but not excluded → throw with the exact `package.json` snippet to add.
- Per-platform mismatch is a mismatch: report which platform, not just "mismatch".

Prefer reading the same config the resolver reads over reimplementing the merge. If
`expo-modules-autolinking` exposes a usable options loader, use it and pin the behavior with
a test; if not, replicate `parsePackageJsonOptions`' merge exactly and test against the
resolver's real output so drift is caught.

**Validation** to keep or add:

- `trust: "pin"` with empty/missing `cliPins` → throw (a release build that can only ever
  hard-fail every connection).
- `cliPins` present with `trust: "link"` → warn: pins are configured but link trust is
  selected, so the pins are what actually get used (embedded always wins) and the `trust`
  value is misleading.
- Keep the SPKI-shape validation and the `deepLinkScheme`-not-in-`scheme` warning as-is.
- Drop the `cliPins`-without-`enableInReleaseBuilds` warning — its condition no longer
  exists.

**Simplify:** the `undefined`-vs-`[]` `cliPins` distinction currently carries ~25 lines of
justification for three lines of behavior. With `trust` explicit, the "absent or
deliberately empty?" question is mostly answered by `trust` — collapse the commentary.

## Acceptance

- Unit tests for every assertion branch, including per-platform mismatch, using the pure
  `__internal` helpers pattern already in `src/__tests__/app-plugin.test.ts`.
- One test asserts the plugin's view of the exclude list matches the real resolver output
  for a fixture project — this is the drift guard.
- `enableInReleaseBuilds` throws with a message naming `include`/`trust`.
- Prebuilding the playground produces the three new keys in `Info.plist` and the manifest,
  and no `ENABLE_IN_RELEASE` anywhere.
