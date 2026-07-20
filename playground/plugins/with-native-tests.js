const path = require("path");
const { withPodfile } = require("expo/config-plugins");

// Playground-only: wires up the Cordierite XCTest target (`Cordierite.podspec`'s `test_spec
// 'Tests'`) so `pnpm test` / CI can exercise the native Swift/ObjC++ implementation directly. This
// is a maintainer testing concern, not something a Cordierite consumer app needs, so it lives here
// as a local config plugin rather than as a `@cordierite/react-native` plugin option.
//
// CocoaPods only creates a pod's test target when its test spec is explicitly requested from the
// Podfile, and Expo Autolinking (see this app's `autolinking.ios.exclude` in app.json) intentionally
// links just the production pod -- so this plugin adds the one Podfile line needed to opt in.

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
