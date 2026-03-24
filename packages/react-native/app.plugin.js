const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
} = require("expo/config-plugins");

const PLUGIN_NAME = "@cordierite/react-native";
const PLUGIN_VERSION = "0.1.0";
const ANDROID_PINS_KEY = "com.callstackincubator.cordierite.CLI_PINS";
const ANDROID_PRIVATE_LAN_KEY =
  "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY";
const IOS_PINS_KEY = "CordieriteCliPins";
const IOS_PRIVATE_LAN_KEY = "CordieriteAllowPrivateLanOnly";

const validateOptions = (options) => {
  const cliPins = options?.cliPins;

  if (!Array.isArray(cliPins) || cliPins.length === 0) {
    throw new Error(
      `${PLUGIN_NAME} requires a non-empty cliPins array in the Expo config plugin options.`
    );
  }

  if (cliPins.some((pin) => typeof pin !== "string" || pin.length === 0)) {
    throw new Error(
      `${PLUGIN_NAME} cliPins must contain only non-empty strings.`
    );
  }

  return {
    cliPins,
    allowPrivateLanOnly: options?.allowPrivateLanOnly ?? false,
  };
};

const withCordierite = (config, rawOptions) => {
  const options = validateOptions(rawOptions);

  config = withInfoPlist(config, (nextConfig) => {
    nextConfig.modResults[IOS_PINS_KEY] = options.cliPins;
    nextConfig.modResults[IOS_PRIVATE_LAN_KEY] = options.allowPrivateLanOnly;
    return nextConfig;
  });

  config = withAndroidManifest(config, (nextConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      nextConfig.modResults
    );

    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      ANDROID_PINS_KEY,
      JSON.stringify(options.cliPins),
      "value"
    );
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      ANDROID_PRIVATE_LAN_KEY,
      String(options.allowPrivateLanOnly),
      "value"
    );

    return nextConfig;
  });

  return config;
};

module.exports = createRunOncePlugin(
  withCordierite,
  PLUGIN_NAME,
  PLUGIN_VERSION
);
