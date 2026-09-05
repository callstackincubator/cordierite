# Build variants: which builds carry Cordierite

Whether Cordierite's native code ships in a given build is decided by autolinking and the
`CORDIERITE_ENABLED` environment variable. It is **not** derived from whether the build is
debuggable.

The JS half is a separate, opt-in step. `CORDIERITE_ENABLED` strips Cordierite's JS too,
but only once the `withCordierite` Metro helper is wired into `metro.config.js` — without
that, the real JS entry is still bundled; it just finds no native module and goes inert.

What a build *trusts* once it does ship is a separate, orthogonal decision — see
[`SECURITY.md`](SECURITY.md#trust-modes).

- [Inclusion is an autolinking decision](#inclusion-is-an-autolinking-decision)
- [`CORDIERITE_ENABLED`](#cordierite_enabled)
- [Verifying against the artifact](#verifying-against-the-artifact)
- [Compiling Cordierite out of production builds](#compiling-cordierite-out-of-production-builds)
- [Excluding it permanently, without the environment variable](#excluding-it-permanently-without-the-environment-variable)
- [JS — swap the module at bundle time](#js--swap-the-module-at-bundle-time)

## Inclusion is an autolinking decision

Inclusion is decided entirely by autolinking, not by anything this package does at
runtime. By default the native module is present in **debug** builds and absent from
**release** builds.

The mechanism differs by platform. On iOS, CocoaPods' `:configurations` is restricted to
`Debug` — a real per-variant *linking* decision.

Android can't use the equivalent `buildTypes` lever the same way, for a package with
static Java registration (`packageInstance`). React Native's Gradle autolinking generates
`PackageList.java` once, shared unfiltered across every variant, so restricting *linking*
by variant would leave that shared file referencing a class absent from an unlisted
variant's classpath — a compile error, not an inert build.

Android therefore links this project into every variant unconditionally, and
`android/build.gradle` instead swaps which Kotlin source set compiles for the `release`
build type, based on `CORDIERITE_ENABLED`. `debug` always compiles the real
implementation; `release` compiles either the same real files (opted in) or a no-op
`CordieritePackage` (the default) that registers nothing.

Either way, the real implementation is genuinely absent from the compiled output it is
excluded from — not a `#if DEBUG`/`FLAG_DEBUGGABLE` check baked into code that ships
regardless. `CordieritePackage.getModule` (Android) and
`CordieriteTurboBridge.swift`/`RCTNativeCordierite.mm` (iOS) contain no build-type check
at all: if the real implementation is compiled/linked into a variant, it is in that
variant's build, full stop. Whether it is is what `CORDIERITE_ENABLED` controls.

**Resulting matrix (`CORDIERITE_ENABLED` × build variant, `trust` orthogonal to both):**

| `CORDIERITE_ENABLED` | Debug / `debug` | Release / `release` |
| --- | --- | --- |
| unset (default) | Native code ships | Native code excluded |
| `1` / `true` | Native code ships | Native code ships |
| `0` / `false` | Native code excluded | Native code excluded |

`trust` (`"link"` vs `"pin"`, resolved as described in
[`SECURITY.md`](SECURITY.md#trust-modes)) only matters in a variant where the native code
ships at all.

## `CORDIERITE_ENABLED`

The per-platform mechanism is described above; this section is what to set, and where
each surface reads it.

A release-signed internal/QA build that still needs Cordierite (an agent-driven CI build,
for example) opts back in explicitly:

```bash
CORDIERITE_ENABLED=1 npx expo prebuild && CORDIERITE_ENABLED=1 npx expo run:ios --configuration Release
```

To go the other direction — strip Cordierite from a **debug** build too, or from every
variant regardless of name — set `CORDIERITE_ENABLED=0`:

```bash
CORDIERITE_ENABLED=0 npx expo prebuild && CORDIERITE_ENABLED=0 npx expo run:ios --configuration Release
```

Accepted values are `1`/`true` and `0`/`false`, case-insensitive; unset or empty means the
dev-only default described above. Any other value is a config error, raised at prebuild.

**One variable, every surface.** Cordierite ships its own `react-native.config.js` that
reads the variable and sets `ios.configurations` in autolinking accordingly;
`android/build.gradle` reads the same variable directly to pick the `release` source set;
and `@cordierite/react-native/metro` reads it too, to strip the JS (see
[JS — swap the module at bundle time](#js--swap-the-module-at-bundle-time)). Metro's own
dev/release split does not thread through to this, so an explicit `CORDIERITE_ENABLED=0`
is still how you strip Cordierite JS from a release bundle.

**It must be set when autolinking resolves** — `pod install` and gradle configure — not
merely when the app compiles. Flipping it and rebuilding without re-running install does
nothing, silently.

**Keyed to build type by name, not by a compiled-in check.** CocoaPods restricts linking
to Xcode configurations literally named `Debug`/`Release`; Gradle restricts it to build
types literally named `debug`/`release`. A custom build-type/configuration name (a
`staging` flavor, say) gets neither — set `CORDIERITE_ENABLED=1` for that pipeline if it
should carry Cordierite. This replaces the `debuggable`/`#if DEBUG` gate removed in 0.4.0
with a real per-variant linking decision instead of a runtime check compiled into every
variant.

## Verifying against the artifact

Verify the result against the artifact rather than the build log:

```bash
cordierite doctor path/to/app-release.apk --assert-absent
```

When Cordierite *is* linked, its podspec and `build.gradle` print
`[cordierite] native module INCLUDED in this build` during pod install / gradle configure.
Nothing prints when it is excluded, because nothing runs — the line exists to catch a
release build that carries Cordierite by mistake, which is the failure that matters. Treat
`doctor` as the authority; the log is an early warning.

`doctor`'s exit codes, its Android detection signals, and the CI wiring live in
[`CI.md`](CI.md#release-gate-cordierite-doctor).

## Compiling Cordierite out of production builds

Removing Cordierite entirely takes two independent halves — the native module and the JS
bundle. `CORDIERITE_ENABLED=0` drives both at once **provided `withCordierite` is wired
into `metro.config.js`** (see [JS — swap the module at bundle
time](#js--swap-the-module-at-bundle-time)); without that helper the variable removes only
the native half.

Both halves are what satisfies an app-store reviewer who expects no "remote control"
surface whatsoever, not just an inert one.

**Either half alone still yields a working, inert app.** The `/noop` Metro swap alone
gives you an app with no Cordierite JS running but the native pod still compiled in
(unused). The autolinking exclude alone gives you an app with no native Cordierite code
but that still imports the real JS entry, which finds no native module and degrades to the
same `/noop`-equivalent behavior described in
[`SECURITY.md`](SECURITY.md#what-a-build-without-the-native-module-does).

## Excluding it permanently, without the environment variable

If a project should never carry Cordierite on a given platform — regardless of pipeline —
declare the exclusion in the app instead. In a `react-native.config.js` at your app root:

```js
module.exports = {
  dependencies: {
    "@cordierite/react-native": {
      platforms: {
        ios: null,
        android: null,
      },
    },
  },
};
```

The Expo-managed equivalent is `expo.autolinking`'s per-platform `exclude` list — but it
must live in **`package.json`**, not `app.json` / `app.config.*`.
`expo-modules-autolinking` reads this config straight from `package.json` at
pod-install/gradle time; an `expo.autolinking` block in `app.json` is silently ignored, so
the exclusion never happens and the native module still ships. This has already shipped as
a bug once, so double-check with the resolver command below after adding it.

```json
{
  "expo": {
    "autolinking": {
      "ios": { "exclude": ["@cordierite/react-native"] },
      "android": { "exclude": ["@cordierite/react-native"] }
    }
  }
}
```

Verify the exclusion actually took effect — this is the only way to catch the `app.json`
mistake above. Run it from your app root after `npm`/`pnpm`/`yarn install`, using the
locally installed binary rather than `npx` (which can silently fetch an unrelated version
from the registry instead of resolving the one your build actually uses):

```sh
./node_modules/.bin/expo-modules-autolinking react-native-config --json --platform ios
```

`@cordierite/react-native` must be absent from the printed `dependencies`.

> **`expo.autolinking.apple` overrides `expo.autolinking.ios`, not merges with it.** The
> CocoaPods driver `pod install` actually invokes always resolves with `--platform apple`,
> and when an `apple` sub-object is present under `expo.autolinking`, it wins outright over
> `ios` — `ios` is only used as a fallback when `apple` is absent. If your app also has an
> `expo.autolinking.apple` block (for reasons unrelated to Cordierite), an `ios`-only
> exclude for `@cordierite/react-native` is silently ignored on iOS; add the exclude to
> `apple` instead (or to both).

> **Excluding on iOS also disables codegen for this package.** `expo-modules-autolinking`
> only generates `CordieriteSpec` — the TurboModule codegen output `RCTNativeCordierite.mm`
> imports — for packages it actually autolinks.
>
> So if your app excludes `@cordierite/react-native` from iOS autolinking but still
> references the `Cordierite` pod directly — for example to attach an XCTest target, as this
> repo's own playground does — the build fails because the generated header no longer
> exists. This only affects setups that both exclude and hand-add the pod; a normal consumer
> app that just wants Cordierite gone never hits it.

There is no corresponding plugin option to keep in sync. Earlier 0.4.0 prereleases had an
`include` option that only *asserted* the plugin's intent matched autolinking; it was
removed once `CORDIERITE_ENABLED` drove autolinking directly, since there were no longer
two sources to reconcile. Passing it now throws at prebuild, naming the replacement.

## JS — swap the module at bundle time

Strip the JS too, so no Cordierite JS (deep-link listener, tool registry, client state
machine) ends up in the bundle either. Excluding the native module alone does not do this:
the real JS entry is still bundled, it just finds no native module and goes inert.

Use the `withCordierite` Metro helper from `@cordierite/react-native/metro` in
`metro.config.js`:

```js
const { getDefaultConfig } = require("expo/metro-config");
const { withCordierite } = require("@cordierite/react-native/metro");

const config = getDefaultConfig(__dirname);

module.exports = withCordierite(config);
```

With no options it reads `CORDIERITE_ENABLED` itself, so the same variable that drops the
native module strips the JS. Pass `{ include: false }` to force the strip, or
`{ include: <your own predicate> }` to key it off something else entirely.

When stripping, every specifier this package exposes as a real JS module entry point
(derived from `package.json`'s `exports`, not a hardcoded `.`/`/auto` list, so a future
entry point is covered automatically) is redirected to `@cordierite/react-native/noop`,
which has no side effect on import, matching `/auto`'s shape without installing anything.
`/noop` itself is never redirected.

If `config.resolver.resolveRequest` is already set — as it typically will be, e.g. the
playground's own workspace-symlink-dedup resolver — `withCordierite` **chains to it** for
every resolution, redirected or not, instead of replacing it; it only falls back to
`context.resolveRequest` when no existing resolver is present. Your existing resolver's
return value is what callers see.

**Call `withCordierite` last**, after anything else that sets
`config.resolver.resolveRequest` — it captures the existing resolver by reference when
called, so a later assignment overwrites (and silently discards) the strip instead of
composing with it.

If you'd rather not touch Metro config, a conditional `require` at each import site works
too (module identity differs per call site, so this is more repetitive but avoids any
bundler-level indirection):

```ts
const { registerTool, useCordieriteTool } = __DEV__
  ? require("@cordierite/react-native")
  : require("@cordierite/react-native/noop");
```

Either way, `/noop` is typed identically to the root entry — both implement the same
shared interface, see `src/public-api.ts` and `src/__tests__/noop-parity.test.ts` — so
switching between them is a drop-in swap. `registerTool` still returns a disposer,
`connect()` still returns a `Promise<void>` (it just always rejects with a
`CordieriteDisabledError`, `code: "cordierite_disabled"`), and `getCordieriteState()`
always reports `"idle"`.

## Related

- [`SECURITY.md`](SECURITY.md) — trust modes, pins, and the threat model
- [`CI.md`](CI.md#release-gate-cordierite-doctor) — the `cordierite doctor` release gate
- [`ARCHITECTURE.md`](ARCHITECTURE.md#11-react-native-sdk) — SDK entry points and client behavior
- [`@cordierite/react-native` README](../packages/react-native/README.md) — getting started and API reference
