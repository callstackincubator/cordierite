const {
  AndroidConfig,
  WarningAggregator,
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
  withPodfile,
} = require("expo/config-plugins");

// NOTE: a few comments below say "task 12" / "task N" in a bare, unqualified way (e.g. "actionable
// config errors", "Testing note"). Those predate this repo's `docs/tasks/` directory and its task
// numbering (opt-in hardening: tasks 01-12) -- they're leftovers from an earlier, differently
// numbered planning doc ("v2") and do NOT refer to `docs/tasks/12-playground-and-verification.md`,
// which covers unrelated content. Left as-is rather than guessed-renumbered; treat them as "an
// earlier design note said so", not as pointers into this directory.

const PLUGIN_NAME = "@cordierite/react-native";
const PLUGIN_VERSION = require("./package.json").version;
const ANDROID_PINS_KEY = "com.callstackincubator.cordierite.CLI_PINS";
const ANDROID_PRIVATE_LAN_KEY =
  "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY";
// Must match CordieritePackage.kt's ENABLE_IN_RELEASE_KEY exactly (opt-in hardening design doc
// part B: default-inert release builds).
const ANDROID_ENABLE_IN_RELEASE_KEY =
  "com.callstackincubator.cordierite.ENABLE_IN_RELEASE";
const IOS_PINS_KEY = "CordieriteCliPins";
const IOS_PRIVATE_LAN_KEY = "CordieriteAllowPrivateLanOnly";

/**
 * `sha256/` followed by a 44-character base64 SHA-256 digest (32 raw bytes -> 43 base64 alphabet
 * characters + one `=` pad character) -- the exact format `cordierite keygen` prints.
 */
const SPKI_PIN_PATTERN = /^sha256\/[A-Za-z0-9+/]{43}=$/;

/**
 * Throws naming the offending value, not just "invalid pins" (task 12: actionable config errors).
 *
 * Opt-in hardening (design doc part B): `cliPins` is only *required* to be a non-empty array when
 * `requireNonEmpty` is true (i.e. `enableInReleaseBuilds: true` -- release builds without pins
 * have no way to trust anything, so that combination is refused outright). Everywhere else --
 * `requireNonEmpty: false`, the default matching every pre-existing call site -- an omitted
 * `cliPins` normalizes to `[]` instead of throwing, matching the daemon's dev-mode zero-config
 * bootstrap: a debug-only app genuinely does not need any build-time pins at all. Whatever *is*
 * given is still validated for correct SPKI-pin shape regardless of `requireNonEmpty`.
 */
function validatePins(cliPins, { requireNonEmpty = true } = {}) {
  if (cliPins === undefined) {
    if (requireNonEmpty) {
      throw new Error(
        `${PLUGIN_NAME} requires a non-empty cliPins array in the Expo config plugin options.`,
      );
    }
    return [];
  }

  if (!Array.isArray(cliPins) || (requireNonEmpty && cliPins.length === 0)) {
    throw new Error(
      `${PLUGIN_NAME} requires a non-empty cliPins array in the Expo config plugin options.`,
    );
  }

  for (const pin of cliPins) {
    if (typeof pin !== "string" || !SPKI_PIN_PATTERN.test(pin)) {
      throw new Error(
        `${PLUGIN_NAME}: cliPins entry ${JSON.stringify(
          pin,
        )} is not a valid SPKI pin. Expected "sha256/" followed by a 44-character base64 ` +
          "SHA-256 digest -- the exact value printed by `cordierite keygen`.",
      );
    }
  }

  return cliPins;
}

/** Expo's `scheme` config field is either a single string or an array of strings. */
function configuredSchemes(expoConfig) {
  const scheme = expoConfig && expoConfig.scheme;
  if (Array.isArray(scheme)) {
    return scheme;
  }
  return typeof scheme === "string" && scheme.length > 0 ? [scheme] : [];
}

/**
 * Pure option validation/normalization -- no Expo mod side effects, so it is directly unit-testable
 * without the Expo mod-compiler machinery (task 12 Testing note). `expoConfig` is only consulted to
 * warn when `deepLinkScheme` is not actually declared in the app's `scheme` field.
 */
function normalizeOptions(rawOptions, expoConfig) {
  // Opt-in hardening (design doc part B): registering Cordierite in a release build at all is
  // itself opt-in, and doing so requires non-empty cliPins -- a release build with no pins has no
  // way to trust anything, so that combination is refused at config time rather than shipping a
  // build that can only ever hard-fail every connection.
  const enableInReleaseBuilds =
    (rawOptions && rawOptions.enableInReleaseBuilds) === true;
  // `cliPinsProvided` tracks whether the option was present in the raw config at all, distinct from
  // `validatePins`' own `[]`-when-omitted normalization: an *absent* `cliPins` must write no pins
  // keys downstream (overview §A dev-mode zero-config), whereas an *explicit* `cliPins: []` was
  // still a deliberate choice by the caller and is written as-is (and still trips the warning
  // below). `enableInReleaseBuilds: true` always implies `cliPinsProvided` -- `validatePins` above
  // already throws otherwise.
  const cliPinsProvided = !!(rawOptions && rawOptions.cliPins !== undefined);
  const cliPins = validatePins(rawOptions && rawOptions.cliPins, {
    requireNonEmpty: enableInReleaseBuilds,
  });
  // Fail-closed default, matching the native readers' default (ARCHITECTURE §11).
  const allowPrivateLanOnly =
    (rawOptions && rawOptions.allowPrivateLanOnly) ?? true;
  const deepLinkScheme = rawOptions && rawOptions.deepLinkScheme;

  const warnings = [];
  if (
    typeof deepLinkScheme === "string" &&
    deepLinkScheme.length > 0 &&
    !configuredSchemes(expoConfig).includes(deepLinkScheme)
  ) {
    warnings.push(
      `deepLinkScheme "${deepLinkScheme}" is not declared in the Expo config's "scheme" field; ` +
        "the Cordierite bootstrap deep link will silently dead-end on this app until you add it.",
    );
  }

  // Opt-in hardening (design doc part B): a team that sets cliPins almost certainly expects pinned
  // trust to work in production. Since release builds are now inert by default, silently ignoring
  // their cliPins would leave them shipping a build that can never connect and no signal why.
  if (cliPinsProvided && !enableInReleaseBuilds) {
    warnings.push(
      `${PLUGIN_NAME}: "cliPins" is set but "enableInReleaseBuilds" is not. Release builds are ` +
        "inert by default; add `enableInReleaseBuilds: true` to the plugin config for cliPins to " +
        "take effect in release, or remove cliPins if it's only meant for local development.",
    );
  }

  return {
    options: {
      // Undefined (not `[]`) when omitted, so `applyInfoPlistChanges`/`applyAndroidManifestChanges`
      // below can tell "no cliPins configured" apart from "explicitly configured empty" and write no
      // pins keys at all in the former case (spec: native readers then take the dev-mode/fail-closed
      // path instead of seeing a spurious empty pins list).
      cliPins: cliPinsProvided ? cliPins : undefined,
      allowPrivateLanOnly,
      deepLinkScheme,
      enableInReleaseBuilds,
    },
    warnings,
  };
}

/**
 * Pure iOS mutation, directly unit-testable against a plain `Info.plist`-shaped object.
 *
 * `options.cliPins` is `undefined` when the caller omitted `cliPins` entirely (see
 * `normalizeOptions`) -- in that case no pins key is written at all, so the native reader falls
 * through to its dev-mode link-pin path (debug) or fails closed (release) instead of seeing a
 * spurious empty pins list.
 */
function applyInfoPlistChanges(infoPlist, options) {
  if (options.cliPins !== undefined) {
    infoPlist[IOS_PINS_KEY] = options.cliPins;
  }
  infoPlist[IOS_PRIVATE_LAN_KEY] = options.allowPrivateLanOnly;
  return infoPlist;
}

/**
 * Pure Android mutation, directly unit-testable against a minimal `AndroidManifest.xml`-shaped
 * object (just `{ manifest: { application: [{ $: { "android:name": "...MainApplication" } }] } }`).
 * Writes `allowPrivateLanOnly` as a real Boolean (not a stringified one) so the in-memory manifest
 * model carries the actual type through to serialization -- the native reader tolerantly accepts
 * either a Boolean or a `"true"`/`"false"` String meta-data value.
 *
 * As with `applyInfoPlistChanges` above, `options.cliPins === undefined` means no pins meta-data
 * key is written at all.
 */
function applyAndroidManifestChanges(androidManifest, options) {
  const application =
    AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);

  if (options.cliPins !== undefined) {
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      ANDROID_PINS_KEY,
      JSON.stringify(options.cliPins),
      "value",
    );
  }
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application,
    ANDROID_PRIVATE_LAN_KEY,
    options.allowPrivateLanOnly,
    "value",
  );
  // Real Boolean, same reasoning as ALLOW_PRIVATE_LAN_ONLY above; CordieritePackage.kt's reader
  // treats a missing key the same as `false`, so writing it explicitly either way is fine.
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application,
    ANDROID_ENABLE_IN_RELEASE_KEY,
    options.enableInReleaseBuilds === true,
    "value",
  );

  return androidManifest;
}

const ENABLE_IN_RELEASE_PODFILE_MARKER =
  "# Cordierite: enableInReleaseBuilds (opt-in hardening design doc part B)";

/**
 * Defines `CORDIERITE_ENABLE_RELEASE` on *every one* of the Cordierite pod's own build
 * configurations -- not just the one literally named `Release`
 * (`CordieriteTurboBridge.swift`/`RCTNativeCordierite.mm` gate their whole implementation behind
 * `#if DEBUG || CORDIERITE_ENABLE_RELEASE`). An app-target-only Xcode build setting would not do
 * this: CocoaPods gives every pod its own build configuration, generated from the podspec, which
 * does not automatically inherit an app target's custom preprocessor defines/Swift compilation
 * conditions. The standard CocoaPods mechanism for reaching into a specific pod's build settings
 * from the consuming app is a `post_install` hook over `installer.pods_project.targets` -- this
 * appends into whichever `post_install do |installer|` hook Expo/React Native already generates
 * (`react_native_post_install` runs from the very same hook), rather than adding a second
 * `post_install` block (Ruby/CocoaPods only runs the last one defined, silently discarding an
 * earlier block -- adding a second hook would break the existing one instead of composing with it).
 *
 * Not scoping this to the `Release` config by name is deliberate, for parity with Android:
 * `CordieritePackage.kt`'s `ENABLE_IN_RELEASE` meta-data enables Cordierite on every
 * non-debuggable build variant, custom build types included, not just one named "release". A
 * custom iOS configuration (e.g. "Staging") gets neither `DEBUG` nor a config-name match, so
 * scoping the injected flag to `build_config.name == 'Release'` left it inert there even with
 * `enableInReleaseBuilds: true` -- the opposite of the equivalent Android build. Applying the flag
 * to every configuration (including Debug, where it's a harmless no-op since Debug is already
 * active via `DEBUG`) is what makes `enableInReleaseBuilds` cover custom iOS configurations the
 * same way it covers custom Android build types.
 *
 * Both languages need the flag defined consistently (task 08/overview §B): Swift reads
 * `SWIFT_ACTIVE_COMPILATION_CONDITIONS`, the ObjC++ bridge (`RCTNativeCordierite.mm`) reads a
 * preprocessor macro from `GCC_PREPROCESSOR_DEFINITIONS` -- Xcode's standard "macro list" build
 * setting, hence the `NAME=1` form rather than a raw `-D` compiler flag. xcodeproj can hand back
 * either setting as a bare String or an Array of Strings depending on what's already configured,
 * so both branches below normalize to whichever shape they append onto (join an Array to a String
 * for the Swift setting; wrap a String into a one-element Array for the GCC setting) rather than
 * assuming one particular shape, which would otherwise corrupt the setting.
 */
function addEnableInReleaseFlagToPodfile(podfile) {
  if (podfile.includes(ENABLE_IN_RELEASE_PODFILE_MARKER)) {
    return podfile;
  }

  const anchor = "post_install do |installer|";
  if (!podfile.includes(anchor)) {
    throw new Error(
      `${PLUGIN_NAME} could not enable Cordierite in release builds: generated Podfile has no ${JSON.stringify(anchor)} hook.`,
    );
  }

  const injected = [
    anchor,
    `    ${ENABLE_IN_RELEASE_PODFILE_MARKER}`,
    "    installer.pods_project.targets.each do |target|",
    "      next unless target.name == 'Cordierite'",
    "      target.build_configurations.each do |build_config|",
    "        conditions = build_config.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] || '$(inherited)'",
    "        conditions = conditions.join(' ') if conditions.is_a?(Array)",
    "        build_config.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = \"#{conditions} CORDIERITE_ENABLE_RELEASE\"",
    "        defs = build_config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] || ['$(inherited)']",
    "        defs = [defs] unless defs.is_a?(Array)",
    "        build_config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] = defs + ['CORDIERITE_ENABLE_RELEASE=1']",
    "      end",
    "    end",
  ].join("\n");

  return podfile.replace(anchor, injected);
}

const withCordierite = (config, rawOptions) => {
  const { options, warnings } = normalizeOptions(rawOptions, config);

  for (const warning of warnings) {
    WarningAggregator.addWarningAndroid(PLUGIN_NAME, warning);
    WarningAggregator.addWarningIOS(PLUGIN_NAME, warning);
  }

  config = withInfoPlist(config, (nextConfig) => {
    nextConfig.modResults = applyInfoPlistChanges(
      nextConfig.modResults,
      options,
    );
    return nextConfig;
  });

  config = withAndroidManifest(config, (nextConfig) => {
    nextConfig.modResults = applyAndroidManifestChanges(
      nextConfig.modResults,
      options,
    );
    return nextConfig;
  });

  if (options.enableInReleaseBuilds) {
    config = withPodfile(config, (nextConfig) => {
      nextConfig.modResults.contents = addEnableInReleaseFlagToPodfile(
        nextConfig.modResults.contents,
      );
      return nextConfig;
    });
  }

  return config;
};

const cordieritePlugin = createRunOncePlugin(
  withCordierite,
  PLUGIN_NAME,
  PLUGIN_VERSION,
);

// Pure helpers exposed for unit tests only (task 12 Testing note) -- not part of the plugin's
// public (Expo config) API.
cordieritePlugin.__internal = {
  SPKI_PIN_PATTERN,
  validatePins,
  configuredSchemes,
  normalizeOptions,
  applyInfoPlistChanges,
  applyAndroidManifestChanges,
  ENABLE_IN_RELEASE_PODFILE_MARKER,
  addEnableInReleaseFlagToPodfile,
};

module.exports = cordieritePlugin;
