/**
 * Single parser for `CORDIERITE_ENABLED`, shared by `react-native.config.js`, `app.plugin.js`, and
 * the Metro helper. Plain CommonJS at the package root because gradle and CocoaPods invoke the
 * autolinking resolver directly and never see `build/`.
 */

const ENV_VAR = "CORDIERITE_ENABLED";
const TRUTHY = new Set(["1", "true"]);
const FALSY = new Set(["0", "false"]);

/**
 * Empty is treated as unset: CI commonly exports a declared-but-unpopulated variable, and failing
 * those pipelines would be hostile. An unrecognized value throws instead of falling back, because
 * fail-open on a typo would silently ship Cordierite into a production build.
 */
function isCordieriteAutolinkEnabled(env = process.env) {
  const raw = env[ENV_VAR];

  if (raw === undefined || raw.trim() === "") {
    return true;
  }

  const normalized = raw.trim().toLowerCase();

  if (TRUTHY.has(normalized)) {
    return true;
  }

  if (FALSY.has(normalized)) {
    return false;
  }

  throw new Error(
    `@cordierite/react-native: ${ENV_VAR} must be one of "1", "true", "0", "false" ` +
      `(or unset), got ${JSON.stringify(raw)}.`,
  );
}

module.exports = { isCordieriteAutolinkEnabled, ENV_VAR };
