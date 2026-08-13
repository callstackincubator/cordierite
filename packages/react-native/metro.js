/**
 * `@cordierite/react-native/metro` — the JS half of stripping Cordierite from a bundle (see
 * `docs/tasks/12-metro-strip-helper.md`). Plain CommonJS at the package root, like
 * `app.plugin.js`, so it stays `require`-able from a Node-run `metro.config.js` without routing
 * through the `tsc` build that produces `build/` for the RN runtime.
 *
 * The native half — whether the Cordierite pod/module is compiled in at all — is decided by
 * autolinking (`docs/tasks/00-overview.md`'s "Inclusion" contract), not by this file. Neither
 * half alone removes both; see the README's "Compiling Cordierite out of production" section.
 */
const PACKAGE_NAME = "@cordierite/react-native";

/** The specifier every redirected import gets rewritten to. Never itself redirected. */
const NOOP_SPECIFIER = `${PACKAGE_NAME}/noop`;

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
 * Only subpaths whose value is a conditions object (an actual JS module entry point, like `"."`
 * or `"./auto"`) are candidates. String-valued subpaths (`"./package.json"`, `"./app.plugin.js"`,
 * `"./metro"` itself) point at files Metro never resolves as a JS module import in the sense this
 * helper cares about, so they are skipped without needing to name them one by one. `/noop` is
 * always excluded, whichever form it takes in `exports`.
 */
function deriveRedirectSpecifiers(exportsField) {
  const specifiers = [];
  for (const subpath of Object.keys(exportsField || {})) {
    const value = exportsField[subpath];
    if (typeof value !== "object" || value === null) {
      // String-valued exports (`"./package.json"`, `"./app.plugin.js"`, `"./metro"`) are direct
      // file redirects, not conditions maps for a JS module entry point.
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
 * `withCordierite(config, options?)` — wraps a Metro `config` so that, when `include: false`,
 * every specifier derived from this package's `exports` (see `deriveRedirectSpecifiers`) resolves
 * to `@cordierite/react-native/noop` instead, stripping the deep-link listener, tool registry, and
 * client state machine from the bundle. `include` mirrors the config plugin's option of the same
 * name (see `docs/tasks/00-overview.md`) — default `true`, meaning "leave resolution alone".
 *
 * Composition: the single most important behavior here. A caller's existing
 * `config.resolver.resolveRequest` (the playground has one, for workspace symlink dedup) is
 * captured and chained to for *every* specifier, redirected or not — never replaced, and never
 * called twice for the same resolution. When no existing resolver is set, falls back to
 * `context.resolveRequest`, matching Metro's own default-resolver convention.
 */
function withCordierite(config, options) {
  const include = options && options.include !== undefined ? options.include : true;
  if (include) {
    return config;
  }

  const redirectSpecifiers = new Set(
    deriveRedirectSpecifiers(require("./package.json").exports),
  );
  const existingResolveRequest = config.resolver && config.resolver.resolveRequest;

  const resolveRequest = (context, moduleName, platform) => {
    const resolveNext = existingResolveRequest || context.resolveRequest;
    const target = redirectSpecifiers.has(moduleName) ? NOOP_SPECIFIER : moduleName;
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
  __testables: { deriveRedirectSpecifiers, specifierForSubpath, NOOP_SPECIFIER, PACKAGE_NAME },
};
