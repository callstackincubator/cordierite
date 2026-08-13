const {
  AndroidConfig,
  WarningAggregator,
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
} = require("expo/config-plugins");

const PLUGIN_NAME = "@cordierite/react-native";
const PLUGIN_VERSION = require("./package.json").version;
const ANDROID_PINS_KEY = "com.callstackincubator.cordierite.CLI_PINS";
const ANDROID_PRIVATE_LAN_KEY =
  "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY";
// CordieritePackage.kt no longer reads this meta-data key (native build-time gating was removed);
// the plugin option that writes it is still present pending its own removal.
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
 * Throws naming the offending value, not just "invalid pins" (actionable config errors).
 *
 * `cliPins` is only *required* to be a non-empty array when
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
 * without the Expo mod-compiler machinery. `expoConfig` is only consulted to
 * warn when `deepLinkScheme` is not actually declared in the app's `scheme` field.
 */
function normalizeOptions(rawOptions, expoConfig) {
  // Registering Cordierite in a release build at all is
  // itself opt-in, and doing so requires non-empty cliPins -- a release build with no pins has no
  // way to trust anything, so that combination is refused at config time rather than shipping a
  // build that can only ever hard-fail every connection.
  const enableInReleaseBuilds =
    (rawOptions && rawOptions.enableInReleaseBuilds) === true;
  // `cliPinsProvided` tracks whether the option was present in the raw config at all, distinct from
  // `validatePins`' own `[]`-when-omitted normalization: an *absent* `cliPins` must write no pins
  // keys downstream (dev-mode zero-config), whereas an *explicit* `cliPins: []` was
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

  // A team that sets cliPins almost certainly expects pinned
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

  return config;
};

const cordieritePlugin = createRunOncePlugin(
  withCordierite,
  PLUGIN_NAME,
  PLUGIN_VERSION,
);

// Pure helpers exposed for unit tests only -- not part of the plugin's
// public (Expo config) API.
cordieritePlugin.__internal = {
  SPKI_PIN_PATTERN,
  validatePins,
  configuredSchemes,
  normalizeOptions,
  applyInfoPlistChanges,
  applyAndroidManifestChanges,
};

module.exports = cordieritePlugin;
