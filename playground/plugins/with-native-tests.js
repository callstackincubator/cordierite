const path = require("path");
const { withPodfile } = require("expo/config-plugins");

// Playground-only: wires up the Cordierite XCTest target (`Cordierite.podspec`'s `test_spec
// 'Tests'`) so `pnpm test` / CI can exercise the native Swift/ObjC++ implementation directly. This
// is a maintainer testing concern, not something a Cordierite consumer app needs, so it lives here
// as a local config plugin rather than as a `@cordierite/react-native` plugin option.
//
// CocoaPods only creates a pod's test target when its test spec is explicitly requested from the
// Podfile. This app excludes `@cordierite/react-native` from Expo Autolinking on both platforms
// (see `expo.autolinking.ios.exclude` / `.android.exclude` in `package.json` -- autolinking reads
// that config from `package.json`, never from `app.json`), so nothing else links the iOS pod. This
// plugin is what actually puts it back for iOS, with the `Tests` test spec requested, so the
// `Cordierite.podspec`'s `test_spec 'Tests'` target exists for `pnpm test` / CI to exercise. Android
// has no equivalent here and stays genuinely excluded, since nothing in the playground needs its
// native module.

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
