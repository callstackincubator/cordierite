const { withStringsXml } = require("expo/config-plugins");

// Playground-only: sets the Android launcher label to "Cordierite" without touching `expo.name`.
//
// `expo.name` is more than a display name: `@expo/cli`'s prebuild step also uses it (sanitized) to
// name the freshly-generated Xcode project/workspace/scheme and the Gradle `rootProject.name`
// (`@expo/config-plugins`' `ios/utils/Xcodeproj.js#sanitizedName` and
// `android/Name.js#sanitizeNameForGradle`). CI (`.github/workflows/test.yaml`) hardcodes
// `playground.xcworkspace` / `-scheme playground`, so renaming `expo.name` would silently break
// those jobs. iOS has a documented way around this -- `ios.infoPlist.CFBundleDisplayName` -- because
// `@expo/config-plugins`' `withDisplayName` plugin checks for it and skips deriving
// `CFBundleDisplayName` from `expo.name` when it's set (see `ios-plugins.js`'s
// `createInfoPlistPluginWithPropertyGuard`). Android's `withName` has no equivalent guard: it always
// writes `strings.xml`'s `app_name` from `expo.name`, unconditionally. This plugin overwrites just
// that one string afterwards, leaving `rootProject.name` (and everything else derived from
// `expo.name`) untouched. Verified against a real `expo prebuild --platform android`: `app_name`
// comes out as "Cordierite" while `rootProject.name` stays "playground". (The exact mod-ordering
// mechanics are `@expo/config-plugins`' internals -- don't assume this plugin's position in the
// `app.json` `plugins` array is what makes it win; re-verify with a real prebuild if you reorder
// that array.)
module.exports = function withAppDisplayName(config) {
  return withStringsXml(config, (config) => {
    const strings = config.modResults.resources.string ?? [];
    const withoutAppName = strings.filter((item) => item.$.name !== "app_name");
    config.modResults.resources.string = [
      ...withoutAppName,
      { $: { name: "app_name" }, _: "Cordierite" },
    ];
    return config;
  });
};
