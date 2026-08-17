/**
 * Hand-written type declaration for `metro.js` (see that file's doc comment for why it's plain
 * CommonJS rather than a `tsc`-built `.ts` source). Metro's own config type lives in
 * `metro-config`, an optional dependency of `expo`/`react-native`, not this package -- typed as
 * `Record<string, unknown>` here rather than adding that dependency just for a type.
 */

export interface WithCordieriteOptions {
  /**
   * Mirrors the `@cordierite/react-native` config plugin's `include` option. `true` (default)
   * leaves Metro's module resolution untouched. `false` redirects every specifier this package
   * exposes as a real JS entry point to `@cordierite/react-native/noop`.
   */
  include?: boolean;
}

/**
 * Wraps a Metro config so that, when `options.include` is `false`, imports of
 * `@cordierite/react-native` (and any other entry point this package exports) resolve to the
 * inert `/noop` entry instead. Chains to `config.resolver.resolveRequest` if already set, rather
 * than replacing it -- call this last, after anything else that sets `resolveRequest`. See the
 * package README's "Compiling Cordierite out of production builds" section.
 */
export function withCordierite<TConfig extends Record<string, unknown>>(
  config: TConfig,
  options?: WithCordieriteOptions,
): TConfig;
