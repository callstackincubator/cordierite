// This file's stdout is consumed as JSON by the autolinking resolver gradle and CocoaPods invoke
// (`expo-modules-autolinking react-native-config --json`). Never `console.log` here -- it corrupts
// that payload and fails the build with an opaque JSON parse error.

const { parseCordieriteEnabled } = require("./autolink-env");

const ANDROID_BASE = {
  packageImportPath:
    "import com.callstackincubator.cordierite.CordieritePackage;",
  packageInstance: "new CordieritePackage()",
};

/**
 * iOS: `configurations` restricts *linking* to real per-variant Xcode configurations -- CocoaPods
 * never links the pod into an unlisted configuration. Android has no equivalent lever here:
 * `buildTypes` only restricts which Gradle configuration this project is linked through
 * (`debugImplementation` vs `implementation`), and RNGP's generated `PackageList.java` is shared,
 * unfiltered, by every variant -- restricting linking by variant would leave that shared file
 * referencing a class absent from the unlisted variant's classpath, a compile error. So Android
 * always links this project (`buildTypes` omitted below) and the dev/release split happens inside
 * `android/build.gradle` instead, via a `CORDIERITE_ENABLED`-gated source set swap -- see that
 * file's own comment. Zero-config default is dev-only; release needs `CORDIERITE_ENABLED=1` to
 * opt in, on both platforms, just through different mechanisms.
 */
const devOnly = {
  android: ANDROID_BASE,
  ios: { configurations: ["Debug"] },
};

const everyBuild = {
  android: ANDROID_BASE,
  ios: { configurations: ["Debug", "Release"] },
};

/** `null` marks a platform as not linkable, which is how a package opts itself out. */
const excluded = { android: null, ios: null };

/**
 * Parse errors fall back to including in every build rather than propagating: the resolver
 * swallows whatever this file throws (exits 0 and autodetects the package anyway), so raising here
 * would read as a gate that does not exist. `app.plugin.js` validates the value where a throw does
 * fail the build, and `cordierite doctor` is what establishes whether a built artifact actually
 * carries Cordierite.
 */
function resolvePlatforms() {
  let enabled;
  try {
    enabled = parseCordieriteEnabled();
  } catch {
    return everyBuild;
  }

  if (enabled === false) {
    return excluded;
  }

  return enabled === true ? everyBuild : devOnly;
}

module.exports = {
  dependency: { platforms: resolvePlatforms() },
  // Exposed for unit testing only -- not part of the documented public API.
  __testables: { resolvePlatforms, devOnly, everyBuild, excluded },
};
