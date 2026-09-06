/**
 * `@cordierite/react-native/metro` — the JS half of stripping Cordierite from a bundle (see
 * `docs/tasks/12-metro-strip-helper.md`). Plain CommonJS at the package root, like
 * `app.plugin.js`, so it stays `require`-able from a Node-run `metro.config.js` without routing
 * through the `tsc` build that produces `build/` for the RN runtime.
 *
 * The native half — whether the Cordierite pod/module is compiled in at all — is decided by
 * autolinking (`docs/tasks/00-overview.md`'s "Inclusion" contract), not by this file. Neither
 * half alone removes both; see `docs/BUILD-VARIANTS.md`'s "Compiling Cordierite out of production
 * builds" section.
 */
const { isCordieriteAutolinkEnabled } = require("./autolink-env");

const PACKAGE_NAME = "@cordierite/react-native";

/** The specifier every redirected import gets rewritten to. Never itself redirected. */
const NOOP_SPECIFIER = `${PACKAGE_NAME}/noop`;

/**
 * `exports` subpaths that are package *infrastructure* -- consumed by tooling (npm, Node's own
 * `exports` resolution, Expo's config-plugin loader, this very file), never `import`ed/`require`d
 * as application JS at runtime -- and therefore never candidates for redirection regardless of
 * whether their value happens to be a string or a conditions object. Kept as a short, explicit
 * denylist (rather than guessing from shape) so a *real* entry point can safely use either
 * `exports` form -- a subpath mapped straight to a string (`"./polyfill": "./build/polyfill.js"`)
 * is just as much a JS module as one behind a conditions object, and both must be covered.
 */
const NON_MODULE_SUBPATHS = new Set([
  "./package.json",
  "./app.plugin.js",
  "./autolink-env.js",
  "./metro",
]);

/**
 * Turns an `exports` subpath key (`"."`, `"./auto"`, ...) into the specifier apps actually
 * `import`/`require` (`"@cordierite/react-native"`, `"@cordierite/react-native/auto"`, ...).
 */
function specifierForSubpath(subpath) {
  return subpath === "." ? PACKAGE_NAME : `${PACKAGE_NAME}/${subpath.slice(2)}`;
}

/**
 * Derives the list of specifiers that should redirect to `/noop` when Cordierite is excluded,
 * from the package's own `exports` map rather than a hardcoded `["." , "/auto"]` list — so a
 * future entry point is covered automatically instead of silently falling through the crack this
 * task exists to close. Exported separately from `withCordierite` so it can be unit-tested
 * against a fabricated `exports` map (see `src/__tests__/metro.test.ts`) without needing a real
 * `require("./package.json")` round-trip.
 *
 * Every subpath is a candidate unless it's in `NON_MODULE_SUBPATHS` (package infrastructure, not
 * an application JS entry point) or redirects to `/noop` itself. This intentionally does *not*
 * key off whether the `exports` value is a string vs. a conditions object -- both are valid ways
 * to declare a real JS module entry point, and treating only conditions-object subpaths as
 * "real" would silently miss a future entry declared with the string form.
 */
function deriveRedirectSpecifiers(exportsField) {
  const specifiers = [];
  for (const subpath of Object.keys(exportsField || {})) {
    if (NON_MODULE_SUBPATHS.has(subpath)) {
      continue;
    }
    const specifier = specifierForSubpath(subpath);
    if (specifier === NOOP_SPECIFIER) {
      continue;
    }
    specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * `withCordierite(config, options?)` — wraps a Metro `config` so that, when Cordierite is excluded,
 * every specifier derived from this package's `exports` (see `deriveRedirectSpecifiers`) resolves
 * to `@cordierite/react-native/noop` instead, stripping the deep-link listener, tool registry, and
 * client state machine from the bundle. With no `include` option it reads `CORDIERITE_ENABLED`,
 * the same variable that drives native autolinking, so one pipeline variable strips both surfaces.
 *
 * Composition: the single most important behavior here. A caller's existing
 * `config.resolver.resolveRequest` (the playground has one, for workspace symlink dedup) is
 * captured and chained to for *every* specifier, redirected or not — never replaced, and never
 * called twice for the same resolution. When no existing resolver is set, falls back to
 * `context.resolveRequest`, matching Metro's own default-resolver convention.
 *
 * **Call this last**, after anything else that sets `config.resolver.resolveRequest` (see
 * `docs/BUILD-VARIANTS.md`'s "JS -- swap the module at bundle time" section). The existing
 * resolver is captured by reference at call time, not read lazily, so
 * `config.resolver.resolveRequest = myResolver` *after* `withCordierite` silently discards the
 * strip rather than erroring — there is no way to detect that misordering from in here, since a
 * later assignment to the returned config object is invisible to this function.
 */
function withCordierite(config, options) {
  // Defaults to the same `CORDIERITE_ENABLED` reading that drives native autolinking, so one
  // pipeline variable strips both surfaces. An explicit `include` still wins, for apps keying the
  // JS strip off their own predicate.
  const include =
    options && options.include !== undefined
      ? options.include
      : isCordieriteAutolinkEnabled();
  if (include) {
    return config;
  }

  const redirectSpecifiers = new Set(
    deriveRedirectSpecifiers(require("./package.json").exports),
  );
  const existingResolveRequest =
    config.resolver && config.resolver.resolveRequest;

  const resolveRequest = (context, moduleName, platform) => {
    const resolveNext = existingResolveRequest || context.resolveRequest;
    const target = redirectSpecifiers.has(moduleName)
      ? NOOP_SPECIFIER
      : moduleName;
    return resolveNext(context, target, platform);
  };

  return {
    ...config,
    resolver: {
      ...config.resolver,
      resolveRequest,
    },
  };
}

module.exports = {
  withCordierite,
  // Exposed for unit testing (`src/__tests__/metro.test.ts`) and only that -- not part of the
  // documented public API.
  __testables: {
    deriveRedirectSpecifiers,
    specifierForSubpath,
    NOOP_SPECIFIER,
    PACKAGE_NAME,
  },
};
