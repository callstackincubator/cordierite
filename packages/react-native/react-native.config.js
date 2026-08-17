// This file's stdout is consumed as JSON by the autolinking resolver gradle and CocoaPods invoke
// (`expo-modules-autolinking react-native-config --json`). Never `console.log` here -- it corrupts
// that payload and fails the build with an opaque JSON parse error.

const { isCordieriteAutolinkEnabled } = require("./autolink-env");

const included = {
  android: {
    packageImportPath:
      "import com.callstackincubator.cordierite.CordieritePackage;",
    packageInstance: "new CordieritePackage()",
  },
  ios: {},
};

/** `null` marks a platform as not linkable, which is how a package opts itself out. */
const excluded = { android: null, ios: null };

/**
 * Parse errors fall back to including rather than propagating: the resolver swallows whatever this
 * file throws (exits 0 and autodetects the package anyway), so raising here would read as a gate
 * that does not exist. `app.plugin.js` validates the value where a throw does fail the build, and
 * `cordierite doctor` is what establishes whether a built artifact actually carries Cordierite.
 */
function resolvePlatforms() {
  try {
    return isCordieriteAutolinkEnabled() ? included : excluded;
  } catch {
    return included;
  }
}

module.exports = { dependency: { platforms: resolvePlatforms() } };
