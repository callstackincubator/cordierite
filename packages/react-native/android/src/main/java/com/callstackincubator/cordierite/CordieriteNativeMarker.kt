package com.callstackincubator.cordierite

/**
 * Exists for exactly one reason: to give `cordierite doctor` (`packages/cordierite/src/artifact-inspect.ts`,
 * docs/tasks/10-android-detection-keep-rule.md) a detection anchor that survives R8/ProGuard minification
 * even when no other keep rule is configured for this package.
 *
 * `consumer-rules.pro` (shipped via `consumerProguardFiles` in `../build.gradle`) keeps this one class's
 * fully-qualified name unminified and unremoved. Consumer apps never call it — it is dead code from a
 * reachability standpoint — so the keep rule is load-bearing: without it, R8 would strip this class
 * entirely, same as everything else with no live reference. Deliberately scoped to a single class rather
 * than the whole package, per the task's "keep the kept surface as small as possible" requirement.
 *
 * Do not rename, delete, or move this class without updating `ANDROID_KEEP_MARKER_CLASS` in
 * `artifact-inspect.ts` and `consumer-rules.pro` in lockstep — the three must always agree on the same
 * fully-qualified name.
 */
internal object CordieriteNativeMarker
