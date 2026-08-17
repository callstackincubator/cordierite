const path = require("path");
const { withPodfile } = require("expo/config-plugins");
const {
  isCordieriteAutolinkEnabled,
} = require("@cordierite/react-native/autolink-env.js");

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
// This app normally ships Cordierite on both platforms. CI's iOS job, however, exercises the
// exclusion against a real build (docs/tasks/13-ios-ci-doctor-gate.md), the same way the Android
// job does -- so this plugin has to recognise that signal and skip hand-adding the pod: excluding
// the package from iOS autolinking also stops its **codegen** (verified in task 02 / task 13), and
// `RCTNativeCordierite.mm` unconditionally imports the generated `CordieriteSpec.h`, so hand-adding
// the pod on top of an exclude fails to compile rather than producing an artifact `cordierite
// doctor` can inspect. Reads `CORDIERITE_ENABLED` through the package's own parser -- the exact
// source its `react-native.config.js` uses to decide autolinking -- rather than re-deriving the
// signal, so this can never drift from what actually gets linked.

const CORDIERITE_PACKAGE_PATH = path.dirname(
  require.resolve("@cordierite/react-native/package.json"),
);

const NATIVE_TESTS_PODFILE_MARKER =
  "# Cordierite native XCTest target (playground only)";

function isCordieriteExcludedFromIosAutolinking() {
  // Reads the same `CORDIERITE_ENABLED` parser the package's own `react-native.config.js` uses to
  // decide autolinking, so this can never disagree with what actually gets linked. An unparseable
  // value throws here exactly as it does in the config plugin.
  return !isCordieriteAutolinkEnabled();
}

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
    if (isCordieriteExcludedFromIosAutolinking()) {
      // Hand-adding a pod for a package iOS autolinking (and therefore codegen) just excluded is
      // incoherent -- leave the Podfile untouched so the exclude recipe actually produces a build
      // without Cordierite, instead of one that fails to compile.
      return nextConfig;
    }

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
