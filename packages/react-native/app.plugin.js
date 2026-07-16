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
const IOS_PINS_KEY = "CordieriteCliPins";
const IOS_PRIVATE_LAN_KEY = "CordieriteAllowPrivateLanOnly";

/**
 * `sha256/` followed by a 44-character base64 SHA-256 digest (32 raw bytes -> 43 base64 alphabet
 * characters + one `=` pad character) -- the exact format `cordierite keygen` prints.
 */
const SPKI_PIN_PATTERN = /^sha256\/[A-Za-z0-9+/]{43}=$/;

/** Throws naming the offending value, not just "invalid pins" (task 12: actionable config errors). */
function validatePins(cliPins) {
  if (!Array.isArray(cliPins) || cliPins.length === 0) {
    throw new Error(
      `${PLUGIN_NAME} requires a non-empty cliPins array in the Expo config plugin options.`
    );
  }

  for (const pin of cliPins) {
    if (typeof pin !== "string" || !SPKI_PIN_PATTERN.test(pin)) {
      throw new Error(
        `${PLUGIN_NAME}: cliPins entry ${JSON.stringify(
          pin
        )} is not a valid SPKI pin. Expected "sha256/" followed by a 44-character base64 ` +
          "SHA-256 digest -- the exact value printed by `cordierite keygen`."
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
  const cliPins = validatePins(rawOptions && rawOptions.cliPins);
  // Fail-closed default, matching the native readers' default (task 09/10 and ARCHITECTURE §11).
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
        "the Cordierite bootstrap deep link will silently dead-end on this app until you add it."
    );
  }

  return {
    options: { cliPins, allowPrivateLanOnly, deepLinkScheme },
    warnings,
  };
}

/** Pure iOS mutation, directly unit-testable against a plain `Info.plist`-shaped object. */
function applyInfoPlistChanges(infoPlist, options) {
  infoPlist[IOS_PINS_KEY] = options.cliPins;
  infoPlist[IOS_PRIVATE_LAN_KEY] = options.allowPrivateLanOnly;
  return infoPlist;
}

/**
 * Pure Android mutation, directly unit-testable against a minimal `AndroidManifest.xml`-shaped
 * object (just `{ manifest: { application: [{ $: { "android:name": "...MainApplication" } }] } }`).
 * Writes `allowPrivateLanOnly` as a real Boolean (not a stringified one) so the in-memory manifest
 * model carries the actual type through to serialization -- coordinate with task 10's native reader,
 * which tolerantly accepts either a Boolean or a `"true"`/`"false"` String meta-data value.
 */
function applyAndroidManifestChanges(androidManifest, options) {
  const application =
    AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);

  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application,
    ANDROID_PINS_KEY,
    JSON.stringify(options.cliPins),
    "value"
  );
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application,
    ANDROID_PRIVATE_LAN_KEY,
    options.allowPrivateLanOnly,
    "value"
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
      options
    );
    return nextConfig;
  });

  config = withAndroidManifest(config, (nextConfig) => {
    nextConfig.modResults = applyAndroidManifestChanges(
      nextConfig.modResults,
      options
    );
    return nextConfig;
  });

  return config;
};

const cordieritePlugin = createRunOncePlugin(
  withCordierite,
  PLUGIN_NAME,
  PLUGIN_VERSION
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
};

module.exports = cordieritePlugin;
