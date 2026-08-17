const {
  AndroidConfig,
  WarningAggregator,
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
} = require("expo/config-plugins");

const { isCordieriteAutolinkEnabled, ENV_VAR } = require("./autolink-env");
const PLUGIN_NAME = "@cordierite/react-native";
const PLUGIN_VERSION = require("./package.json").version;
const ANDROID_PINS_KEY = "com.callstackincubator.cordierite.CLI_PINS";
const ANDROID_PRIVATE_LAN_KEY =
  "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY";
const ANDROID_TRUST_KEY = "com.callstackincubator.cordierite.TRUST";
const IOS_PINS_KEY = "CordieriteCliPins";
const IOS_PRIVATE_LAN_KEY = "CordieriteAllowPrivateLanOnly";
const IOS_TRUST_KEY = "CordieriteTrust";

/**
 * `sha256/` followed by a 44-character base64 SHA-256 digest (32 raw bytes -> 43 base64 alphabet
 * characters + one `=` pad character) -- the exact format `cordierite keygen` prints.
 */
const SPKI_PIN_PATTERN = /^sha256\/[A-Za-z0-9+/]{43}=$/;

/**
 * Throws naming the offending value, not just "invalid pins" (actionable config errors).
 * `cliPins` is always optional here -- whether an empty/missing `cliPins` is actually *usable*
 * depends on `trust` (see `normalizeOptions`), not on this shape check. Whatever is given is
 * still validated for correct SPKI-pin shape.
 */
function validatePins(cliPins) {
  if (cliPins === undefined) {
    return [];
  }

  if (!Array.isArray(cliPins)) {
    throw new Error(
      `${PLUGIN_NAME} requires "cliPins" to be an array of SPKI pins, got ${JSON.stringify(cliPins)}.`,
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
  // Never published (npm latest is 0.3.1, this branch is 0.4.0-rc.1), so no deprecation shim --
  // fail loudly and name the replacement instead of silently ignoring a stale option.
  if (
    rawOptions &&
    Object.prototype.hasOwnProperty.call(rawOptions, "enableInReleaseBuilds")
  ) {
    throw new Error(
      `${PLUGIN_NAME}: "enableInReleaseBuilds" has been removed. Whether Cordierite ships in a ` +
        `build is decided by autolinking alone -- set ${ENV_VAR}=0 in the build that should not ` +
        'carry it; what a build trusts is decided by "trust".',
    );
  }

  // `include` only ever existed on this unreleased branch, where it asserted that plugin intent
  // matched the app's autolinking config. `CORDIERITE_ENABLED` now drives autolinking directly, so
  // there are no longer two sources to reconcile. Rejected rather than ignored so a config copied
  // from the pre-rewrite README fails at prebuild instead of quietly doing nothing.
  if (
    rawOptions &&
    Object.prototype.hasOwnProperty.call(rawOptions, "include")
  ) {
    throw new Error(
      `${PLUGIN_NAME}: "include" has been removed. Set ${ENV_VAR}=0 (or "false") in the build ` +
        "that should not carry Cordierite; autolinking reads it directly.",
    );
  }

  // Validated here because a throw at prebuild actually fails the build. The autolinking resolver
  // swallows whatever `react-native.config.js` throws -- it exits 0 and autodetects the package --
  // so that file cannot enforce this, and a typo would otherwise silently ship Cordierite.
  isCordieriteAutolinkEnabled();

  // Tracked separately from `cliPins.length` (below) only to compute `trust`'s default: an
  // explicit `cliPins: []` still counts as "provided" for that purpose, even though it validates
  // to the same empty array as an omitted one.
  const cliPinsProvided = !!(rawOptions && rawOptions.cliPins !== undefined);
  const cliPins = validatePins(rawOptions && rawOptions.cliPins);

  const rawTrust = rawOptions && rawOptions.trust;
  let trust;
  if (rawTrust === undefined) {
    trust = cliPinsProvided ? "pin" : "link";
  } else if (rawTrust === "link" || rawTrust === "pin") {
    trust = rawTrust;
  } else {
    // A typo here must be a config-time error, not a silent fallback to the default -- see
    // 00-overview.md's amendment during task 05. The native readers make the same call, but
    // catching it here means an app author sees it at prebuild instead of on a device.
    throw new Error(
      `${PLUGIN_NAME}: "trust" must be "link" or "pin", got ${JSON.stringify(rawTrust)}.`,
    );
  }

  if (trust === "pin" && cliPins.length === 0) {
    throw new Error(
      `${PLUGIN_NAME}: "trust: \\"pin\\"" requires a non-empty "cliPins" array -- a build with ` +
        "no embedded pins and pin-only trust can never trust anything.",
    );
  }

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

  // Embedded pins always win over `linkPin` regardless of `trust` (see `resolveTrustedPins` on
  // both platforms), so `trust: "link"` alongside real `cliPins` is misleading, not dangerous --
  // a warning, not an error.
  if (cliPins.length > 0 && trust === "link") {
    warnings.push(
      `${PLUGIN_NAME}: "cliPins" is set but "trust" is "link". Embedded pins always take priority ` +
        "over link trust at runtime, so cliPins is what actually gets used regardless -- set " +
        '"trust: \\"pin\\"" (or omit "trust", since that is the default whenever cliPins is present) ' +
        "to match what actually happens.",
    );
  }

  return {
    options: { trust, cliPins, allowPrivateLanOnly, deepLinkScheme },
    warnings,
  };
}

/**
 * Pure iOS mutation, directly unit-testable against a plain `Info.plist`-shaped object.
 */
function applyInfoPlistChanges(infoPlist, options) {
  infoPlist[IOS_PINS_KEY] = options.cliPins;
  infoPlist[IOS_PRIVATE_LAN_KEY] = options.allowPrivateLanOnly;
  infoPlist[IOS_TRUST_KEY] = options.trust;
  return infoPlist;
}

/**
 * Pure Android mutation, directly unit-testable against a minimal `AndroidManifest.xml`-shaped
 * object (just `{ manifest: { application: [{ $: { "android:name": "...MainApplication" } }] } }`).
 * Writes `allowPrivateLanOnly` as a real Boolean (not a stringified one) so the in-memory manifest
 * model carries the actual type through to serialization -- the native reader tolerantly accepts
 * either a Boolean or a `"true"`/`"false"` String meta-data value.
 */
function applyAndroidManifestChanges(androidManifest, options) {
  const application =
    AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);

  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application,
    ANDROID_PINS_KEY,
    JSON.stringify(options.cliPins),
    "value",
  );
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application,
    ANDROID_PRIVATE_LAN_KEY,
    options.allowPrivateLanOnly,
    "value",
  );
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application,
    ANDROID_TRUST_KEY,
    options.trust,
    "value",
  );

  return androidManifest;
}

const withCordierite = (config, rawOptions) => {
  const { options, warnings } = normalizeOptions(rawOptions, config);

  // A build autolinking has excluded must carry no Cordierite footprint at all, so the plugin
  // writes nothing rather than leaving orphaned CLI_PINS/TRUST manifest and Info.plist keys behind.
  // `cordierite doctor` reads those keys as an inclusion signal, so writing them into a build with
  // no native module would make `--assert-absent` fail on an artifact that is genuinely clean --
  // and it would leak the app's pin configuration into a build that has no use for it. This is why
  // `CORDIERITE_ENABLED=0` alone is the whole recipe: apps do not also have to strip the plugin.
  if (!isCordieriteAutolinkEnabled()) {
    return config;
  }

  const emitWarning = (warning) => {
    WarningAggregator.addWarningAndroid(PLUGIN_NAME, warning);
    WarningAggregator.addWarningIOS(PLUGIN_NAME, warning);
  };

  for (const warning of warnings) {
    emitWarning(warning);
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
