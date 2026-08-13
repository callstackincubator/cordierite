# 12 — Ship the Metro strip as a helper, not a README snippet

**Depends on the rest of the series (all merged). No parallel siblings.**

## Goal

`@cordierite/react-native/metro` exports a `withCordierite(config, options)` that performs the
JS-side strip, replacing the copy-paste `resolveRequest` snippet in the package README.

## Why

Inclusion has two layers. The native layer is now decided by autolinking, with a drift-guard
test in the config plugin (task 06) and a CI assertion via `cordierite doctor` (tasks 08–10).
The JS layer — swapping `@cordierite/react-native` and `/auto` for `/noop` so the deep-link
listener, tool registry, and client state machine leave the bundle — is still a snippet users
copy out of `packages/react-native/README.md` by hand, and **nothing in this repo executes
it**. `playground/metro.config.js` has a `resolveRequest`, but only for workspace symlink
dedup; it contains no Cordierite logic.

That is the same shape as the bug that started this series: a documented recipe that had
never worked. Concrete things the snippet gets wrong that a helper would not:

- **Composition.** The snippet chains to a captured `original`. A user who already has a
  `resolveRequest` — as the playground does — can easily end up clobbering one or the other,
  and the failure is silent in both directions.
- **New entry points.** The snippet hardcodes `.` and `/auto`. Add a subpath later and it
  silently stops covering the package, with no test to notice.
- Nobody can unit-test a snippet.

## Scope

- New entry `@cordierite/react-native/metro`, wired into `package.json`'s `exports`.
- `withCordierite(config, options?)` returns the config with resolution redirected to `/noop`
  when Cordierite is excluded.
- **Option naming mirrors the config plugin**: `include` (boolean), default `true`. A reader
  who has configured the plugin should not have to learn a second vocabulary; `include:
  false` should mean the same thing in both places.
- **Preserve any existing `resolveRequest`** — chain to it, and fall back to
  `context.resolveRequest` when absent. Preserving the caller's resolver is the single most
  important behavior here.
- **Derive the redirected specifiers from `package.json`'s `exports`** rather than hardcoding
  `.` and `/auto`, so a future entry point cannot be silently missed. Never redirect `/noop`
  itself.
- Replace the README snippet with the helper; keep a short "what it does" note so the
  mechanism stays legible, and mention that this is the JS half — autolinking is the native
  half, and neither alone removes both.

## Watch for

The helper is `require`d from a CJS `metro.config.js` running in Node, while the package's
`src/` builds through `tsc` for the RN runtime. Make sure what ships is actually requireable
from CJS — `app.plugin.js` is plain JS at the package root for exactly this reason, and that
may be the right precedent rather than routing this through the TS build.

## Acceptance

- Unit tests against a fake Metro resolver context: default keeps the real module;
  `include: false` redirects every non-`/noop` entry; an existing `resolveRequest` is still
  called and its result honoured; `/noop` is never redirected; an unrelated specifier passes
  through untouched.
- A test asserts the redirect list is derived from `exports`, so adding an entry point
  without updating the helper fails.
- **End-to-end, not just unit-tested:** bundle the playground with `include: false` (e.g.
  `npx expo export --platform android`) and grep the emitted bundle for a string that only
  the real entry contains, proving the JS actually left the bundle. Do the same with
  `include: true` and prove it is present. A helper that type-checks but doesn't strip is
  the failure this task exists to prevent.
- `packages/react-native` suite green.
