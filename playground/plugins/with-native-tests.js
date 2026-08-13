const path = require("path");
const { withPodfile } = require("expo/config-plugins");

// Playground-only: wires up the Cordierite XCTest target (`Cordierite.podspec`'s `test_spec
// 'Tests'`) so `pnpm test` / CI can exercise the native Swift/ObjC++ implementation directly. This
// is a maintainer testing concern, not something a Cordierite consumer app needs, so it lives here
// as a local config plugin rather than as a `@cordierite/react-native` plugin option.
//
// CocoaPods only creates a pod's test target when its test spec is explicitly requested from the
// Podfile, and Expo Autolinking's own pod declaration never requests one -- so this plugin adds a
// second, explicit `pod 'Cordierite'` line with `:testspecs => ['Tests']`. CocoaPods resolves both
// declarations to the single pod below; this does not double-link it (verified: `Podfile.lock` has
// exactly one `Cordierite` entry after a clean `pod install`).
//
// This app deliberately does NOT exclude `@cordierite/react-native` from autolinking on either
// platform (the real place for that is `expo.autolinking.{ios,android}.exclude` in `package.json`
// -- autolinking reads it from `package.json` only, never from `app.json`; see the package README's
// "Compiling Cordierite out of production builds" section for that recipe). Excluding it here would
// break this playground: the app imports `@cordierite/react-native/auto` and calls its hooks
// directly, iOS's `RCTNativeCordierite.mm` unconditionally imports the `CordieriteSpec` header that
// only exists when autolinking's codegen step runs for this module, and CI's Android job runs
// `:cordierite_react-native:testDebugUnitTest`, which requires the Gradle project autolinking
// creates. An app that wants to strip Cordierite out entirely should follow the README/SECURITY.md
// recipe in its own `package.json`, not this one.

const CORDIERITE_PACKAGE_PATH = path.dirname(
  require.resolve("@cordierite/react-native/package.json"),
);

const NATIVE_TESTS_PODFILE_MARKER =
  "# Cordierite native XCTest target (playground only)";

function addNativeTestsPodToPodfile(podfile, podPath) {
  if (podfile.includes(NATIVE_TESTS_PODFILE_MARKER)) {
    return podfile;
  }

  const anchor = "  use_expo_modules!";
  if (!podfile.includes(anchor)) {
    throw new Error(
      `with-native-tests could not add the Cordierite XCTest target: generated Podfile has no ${JSON.stringify(anchor)} anchor.`,
    );
  }

  const escapedPath = podPath.replace(/'/g, "\\\\'");
  return podfile.replace(
    anchor,
    `${anchor}\n\n  ${NATIVE_TESTS_PODFILE_MARKER}\n  pod 'Cordierite', :path => '${escapedPath}', :testspecs => ['Tests']`,
  );
}

const withNativeTests = (config) =>
  withPodfile(config, (nextConfig) => {
    const podPath = path.relative(
      nextConfig.modRequest.platformProjectRoot,
      CORDIERITE_PACKAGE_PATH,
    );
    nextConfig.modResults.contents = addNativeTestsPodToPodfile(
      nextConfig.modResults.contents,
      podPath,
    );
    return nextConfig;
  });

module.exports = withNativeTests;
