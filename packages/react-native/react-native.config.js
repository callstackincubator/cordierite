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
 * `buildTypes`/`configurations` restrict linking to real per-variant Xcode configurations /
 * Gradle build types -- not a JS-side simulation. Zero-config default is dev-only; release needs
 * `CORDIERITE_ENABLED=1` to opt in.
 */
const devOnly = {
  android: { ...ANDROID_BASE, buildTypes: ["debug"] },
  ios: { configurations: ["Debug"] },
};

const everyBuild = {
  android: { ...ANDROID_BASE, buildTypes: ["debug", "release"] },
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
