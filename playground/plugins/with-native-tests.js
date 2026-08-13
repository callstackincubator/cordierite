const fs = require("fs");
const path = require("path");
const { withPodfile } = require("expo/config-plugins");
const cordieritePlugin = require("@cordierite/react-native/app.plugin.js");

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
// This app normally does NOT exclude `@cordierite/react-native` from autolinking on either platform
// (the real place for that is `expo.autolinking.{ios,android}.exclude` in `package.json` --
// autolinking reads it from `package.json` only, never from `app.json`; see the package README's
// "Compiling Cordierite out of production builds" section for that recipe). CI's iOS job, however,
// exercises exactly that exclude recipe against a real build (docs/tasks/13-ios-ci-doctor-gate.md),
// the same way the Android job already does -- so this plugin has to recognise that signal and skip
// hand-adding the pod when it's present: excluding the package from iOS autolinking also stops its
// **codegen** (verified in task 02 / task 13), and `RCTNativeCordierite.mm` unconditionally imports
// the generated `CordieriteSpec.h`, so hand-adding the pod on top of an exclude fails to compile
// rather than producing an artifact `cordierite doctor` can inspect. Reads the exclusion signal
// through `@cordierite/react-native/app.plugin.js`'s own `resolvePackageJsonAutolinkingExclude`
// helper -- the exact merge (`apple` before `ios`) the plugin itself asserts `include` against --
// rather than re-deriving it, so this can never drift from what the real plugin/CI recipe considers
// "excluded".

const CORDIERITE_PACKAGE_NAME = "@cordierite/react-native";

const CORDIERITE_PACKAGE_PATH = path.dirname(
  require.resolve("@cordierite/react-native/package.json"),
);

const NATIVE_TESTS_PODFILE_MARKER =
  "# Cordierite native XCTest target (playground only)";

function isCordieriteExcludedFromIosAutolinking(projectRoot) {
  let packageJson;
  try {
    packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    );
  } catch {
    // Same fail-open-to-"not excluded" default the real plugin uses when package.json can't be
    // read: this plugin will still add the pod, matching the pre-exclude default behavior.
    return false;
  }

  return cordieritePlugin.__internal
    .resolvePackageJsonAutolinkingExclude(packageJson, "ios")
    .includes(CORDIERITE_PACKAGE_NAME);
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
    if (
      isCordieriteExcludedFromIosAutolinking(
        nextConfig.modRequest.projectRoot,
      )
    ) {
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
