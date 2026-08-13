const {
  AndroidConfig,
  WarningAggregator,
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PLUGIN_NAME = "@cordierite/react-native";
const PLUGIN_VERSION = require("./package.json").version;
const ANDROID_PINS_KEY = "com.callstackincubator.cordierite.CLI_PINS";
const ANDROID_PRIVATE_LAN_KEY =
  "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY";
const ANDROID_TRUST_KEY = "com.callstackincubator.cordierite.TRUST";
const IOS_PINS_KEY = "CordieriteCliPins";
const IOS_PRIVATE_LAN_KEY = "CordieriteAllowPrivateLanOnly";
const IOS_TRUST_KEY = "CordieriteTrust";

/** The two platforms `include` is asserted against (see `assertIncludeMatchesAutolinking`). */
const AUTOLINKING_PLATFORMS = ["ios", "android"];

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
        'build is now decided by autolinking alone ("include" only asserts that intent matches ' +
        'reality -- see the README); what a build trusts is decided by "trust". Remove ' +
        '"enableInReleaseBuilds" from the plugin config and set "include"/"trust" instead.',
    );
  }

  const include = (rawOptions && rawOptions.include) ?? true;
  if (typeof include !== "boolean") {
    throw new Error(
      `${PLUGIN_NAME}: "include" must be a boolean, got ${JSON.stringify(include)}.`,
    );
  }

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
    options: { include, trust, cliPins, allowPrivateLanOnly, deepLinkScheme },
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

/**
 * Mirrors `expo-modules-autolinking`'s `parsePackageJsonOptions` merge for the `exclude` field
 * only: `expo.autolinking`'s root object, with the requested platform's sub-object (if any)
 * spread on top -- a platform key fully replaces the root's `exclude`, it does not concatenate
 * with it. Verified against the real resolver (`mergeLinkingOptionsAsync` from
 * `expo-modules-autolinking`) in `src/__tests__/app-plugin.test.ts`'s drift-guard test; if
 * `expo-modules-autolinking` changes this merge, that test breaks and this function must follow.
 *
 * `platform` is `"ios"` | `"android"` -- this package's contract (00-overview.md) and README only
 * ever document `expo.autolinking.ios`/`.android`. But the CocoaPods driver that actually invokes
 * the resolver during `pod install` always passes `--platform apple`
 * (`expo-modules-autolinking`'s `scripts/ios/autolinking_manager.rb`), and
 * `parsePackageJsonOptions` only falls back to the `ios` sub-object when an `apple` sub-object is
 * *absent* -- an `autolinking.apple` entry, if present, wins over `autolinking.ios` outright, not
 * merges with it. So for `platform: "ios"` here, `apple` must be checked first with `ios` as the
 * fallback, exactly mirroring that resolution, or an app that follows Expo's own docs and uses the
 * `apple` key would see this assertion disagree with what `pod install` actually does -- precisely
 * the silent-drift class of bug this whole assertion exists to catch (task 02).
 *
 * Deliberately reads **only** `package.json` -- never `app.json`/`app.config.*`, which
 * `expo-modules-autolinking` never consults for this (verified in task 02; see 00-overview.md).
 */
function resolvePackageJsonAutolinkingExclude(packageJson, platform) {
  const isPlainObject = (value) =>
    value != null && typeof value === "object" && !Array.isArray(value);

  const expo =
    isPlainObject(packageJson) && isPlainObject(packageJson.expo)
      ? packageJson.expo
      : null;
  const autolinking =
    expo && isPlainObject(expo.autolinking) ? expo.autolinking : null;

  // `apple` before `ios`, matching the real resolver's fallback order for the iOS platform; only
  // one candidate key for android.
  const platformKeys = platform === "ios" ? ["apple", "ios"] : [platform];
  let platformOptions = null;
  for (const key of platformKeys) {
    if (autolinking && isPlainObject(autolinking[key])) {
      platformOptions = autolinking[key];
      break;
    }
  }

  const merged = { ...autolinking, ...platformOptions };

  return Array.isArray(merged.exclude)
    ? merged.exclude.filter((entry) => typeof entry === "string")
    : [];
}

/**
 * Bare-RN exclusion: `react-native.config.js`'s `dependencies["@cordierite/react-native"].platforms`
 * with the requested platform explicitly set to `null`. This is the community CLI's own
 * exclusion mechanism (distinct from `expo-modules-autolinking`, which never reads this file);
 * `expo-modules-autolinking` itself also only reads `package.json`, so an Expo app can never rely
 * on this path -- it exists for apps with no Expo autolinking involved at all.
 */
function isExcludedByReactNativeConfig(reactNativeConfig, platform) {
  const dependency =
    reactNativeConfig &&
    reactNativeConfig.dependencies &&
    reactNativeConfig.dependencies[PLUGIN_NAME];
  const platforms = dependency && dependency.platforms;
  return !!platforms && platforms[platform] === null;
}

/**
 * The `include` assertion (see `docs/tasks/06-config-plugin-rewrite.md`): `include` is declared
 * intent, never a mechanism (a config plugin cannot reach into the separate process that runs
 * `expo-modules-autolinking`/gradle at pod-install/build time), so this checks that the intent
 * and the real autolinking config agree, and throws a copy-pasteable fix when they don't.
 * Per-platform: `platform` is `"ios"` | `"android"`.
 */
function assertIncludeMatchesAutolinking({
  include,
  platform,
  packageJson,
  reactNativeConfig,
}) {
  const excludedByPackageJson = resolvePackageJsonAutolinkingExclude(
    packageJson,
    platform,
  ).includes(PLUGIN_NAME);
  const excludedByReactNativeConfig = isExcludedByReactNativeConfig(
    reactNativeConfig,
    platform,
  );
  const excluded = excludedByPackageJson || excludedByReactNativeConfig;

  if (include && excluded) {
    const source = excludedByPackageJson
      ? '"expo.autolinking" in package.json'
      : '"dependencies" in react-native.config.js';
    throw new Error(
      `${PLUGIN_NAME}: plugin option "include: true" (the default) but ${platform} autolinking ` +
        `excludes "${PLUGIN_NAME}" via ${source}. Either remove that exclude entry for the ` +
        `"${platform}" platform, or set "include: false" in the ${PLUGIN_NAME} plugin config to ` +
        "match what autolinking actually does.",
    );
  }

  if (!include && !excluded) {
    throw new Error(
      `${PLUGIN_NAME}: plugin option "include: false" but ${platform} autolinking does not exclude ` +
        `"${PLUGIN_NAME}". Add the following to package.json (not app.json/app.config.* -- ` +
        "expo-modules-autolinking never reads those) to actually exclude it:\n" +
        `{ "expo": { "autolinking": { "${platform}": { "exclude": ["${PLUGIN_NAME}"] } } } }`,
    );
  }
}

/**
 * Best-effort JSON read; returns `null` on any failure so callers can degrade gracefully. `onWarn`
 * is called with a human-readable reason so a broken/unparsable `package.json` doesn't silently
 * make the `include`/autolinking assertion below see an empty config and draw the wrong
 * conclusion -- see `readReactNativeConfigSync` for the same reasoning.
 */
function readJsonFileSync(filePath, onWarn) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    onWarn(
      `could not read or parse "${filePath}" (${error.message}); the "include"/autolinking ` +
        "consistency check may be inaccurate as a result.",
    );
    return null;
  }
}

/**
 * Best-effort `react-native.config.js` load; returns `null` when the file is absent, or when it
 * fails to load (e.g. an ESM-only app, or a config with unrelated require-time side effects that
 * throw) -- in the latter case `onWarn` is called, since a bare-RN exclusion the plugin cannot
 * read would otherwise be silently treated the same as "no exclusion declared here", which could
 * make the `include`/autolinking assertion below wrongly conclude the module is not excluded.
 */
function readReactNativeConfigSync(projectRoot, onWarn) {
  const configPath = path.join(projectRoot, "react-native.config.js");
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- dynamic path, not a static import
    return require(configPath);
  } catch (error) {
    onWarn(
      `could not load "${configPath}" (${error.message}); the "include"/autolinking consistency ` +
        "check may be inaccurate as a result.",
    );
    return null;
  }
}

const withCordierite = (config, rawOptions) => {
  const { options, warnings } = normalizeOptions(rawOptions, config);

  const emitWarning = (warning) => {
    WarningAggregator.addWarningAndroid(PLUGIN_NAME, warning);
    WarningAggregator.addWarningIOS(PLUGIN_NAME, warning);
  };

  for (const warning of warnings) {
    emitWarning(warning);
  }

  // `config._internal.projectRoot` is populated by `@expo/config` (`withInternal`) before any
  // plugin runs and is how other first-party Expo plugins read the app root synchronously at
  // this point in the pipeline; `config.modRequest.projectRoot` is not yet available here (that
  // only exists inside the `with*Mod` callbacks below, run later, once per platform).
  const projectRoot = config._internal && config._internal.projectRoot;
  if (projectRoot) {
    const packageJson =
      readJsonFileSync(path.join(projectRoot, "package.json"), emitWarning) ||
      {};
    const reactNativeConfig = readReactNativeConfigSync(
      projectRoot,
      emitWarning,
    );

    for (const platform of AUTOLINKING_PLATFORMS) {
      assertIncludeMatchesAutolinking({
        include: options.include,
        platform,
        packageJson,
        reactNativeConfig,
      });
    }
  } else {
    emitWarning(
      'could not determine the project root; skipped verifying that "include" matches the ' +
        "real autolinking configuration.",
    );
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
  resolvePackageJsonAutolinkingExclude,
  isExcludedByReactNativeConfig,
  assertIncludeMatchesAutolinking,
};

module.exports = cordieritePlugin;
