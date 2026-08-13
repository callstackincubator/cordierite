# 07 — Expose effective native config to JS

**Wave 2. Depends on 05. Parallel with 06.**

## Goal

JS can read the trust mode and pin configuration this build actually has, from the same
source native uses.

## Why

JS currently infers nothing about how the build is configured; the trust decision lives
entirely in native. Once `trust` is explicit, JS wants it for diagnostics — the playground's
status screen, a clear error when a link carries no pin in `trust: "link"`, and anything an
agent might reasonably ask about the app it is driving.

**Use TurboModule `getConstants()`, not `Constants.expoConfig.extra`.** The `extra` route
does work — `expo-constants/scripts/getAppConfig.js` runs at native build time and calls
`getConfig(...)`, which applies plugin functions via `withConfigPlugins`, so a plugin's
`config.extra` mutation reaches `Constants.expoConfig.extra`. But it would be a *second*
source of truth for a value native already reads, it needs `expo-constants`, and it does not
exist for bare RN. Native constants can't disagree with native behavior. Given the
app.json-vs-package.json bug in task 02, prefer the representation that cannot drift.

Note for anyone tempted later: neither route yields a *compile-time* constant. Bundling runs
in a separate process after prebuild, so nothing here enables dead-code elimination. The
only things Metro can eliminate on are `process.env.EXPO_PUBLIC_*` (task 03) and the
existing `resolveRequest` swap to `/noop`.

## Scope

- `src/NativeCordierite.ts`: add `getConstants(): { trust: string; hasEmbeddedPins: boolean;
  allowPrivateLanOnly: boolean }`. Do **not** expose the pin values themselves — the
  fingerprints are not secret, but there is no use case, and a smaller surface is the
  default.
- Implement on both platforms from the same keys `resolveTrustedPins` reads (task 05); no
  second parse path.
- Surface through the public API as something small and honest — e.g.
  `getCordieriteBuildConfig()` — wrapped in `noopIfNativeUnavailable` like every other
  export, with the matching inert implementation in `noop.ts` returning a documented
  "absent" shape.
- Update the playground status screen to show it. That screen is the fastest way to tell,
  on a device, which trust mode an artifact was actually built with.

## Acceptance

- `__tests__/noop-parity.test.ts` and the public-API type test cover the new export.
- Native unit tests assert the constants match what trust resolution used, on both
  platforms.
- Playground status screen shows the real value in a Release build.
