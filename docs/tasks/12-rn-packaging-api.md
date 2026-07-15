# 12 — React Native packaging & public API surface

## Goal

Ship the developer-facing shape of the SDK: side-effect-free root entry, `/auto` and
`/noop` entries, `useCordieriteTool`, schema-exporter warning, config-plugin fixes,
and the production compile-out recipe (ARCHITECTURE §11).

## Depends on

11.

## Read first

- `docs/ARCHITECTURE.md` §11 (entry points, API list).
- `packages/react-native/src/index.ts` (current side-effectful root: eager
  `TurboModuleRegistry.getEnforcing` + listener install at import, ~:26-28),
  `package.json` `exports` map, `app.plugin.js` (no pin validation, string metadata
  bug context — see task 10), `src/CordieriteModule.ts`, `src/schema.ts` (~:61-75
  silent `{}` fallback).

## Scope

1. **Entries** (update `package.json` `exports` with `react-native`/`default`
   conditions per entry; keep the `.web.ts` platform split working):
   - `.` — side-effect-free: exports `registerTool`, `useCordieriteTool`, `postEvent`,
     `installCordieriteDeepLinkBootstrap`, `addCordieriteListener`,
     `getCordieriteState`, `connect` (manual bootstrap), types. TurboModule lookup
     must be **lazy**: first native call, not import time (importing the package in
     Expo Go or a misconfigured build must not crash until a native call is made —
     then fail with an actionable message naming the dev-build requirement).
   - `./auto` — importing it installs the deep-link bootstrap with defaults (the v1
     root behavior). Must be listed in `sideEffects` correctly: root entry
     side-effect-free, `/auto` marked as having side effects.
   - `./noop` — same public API, inert: registrations return no-op disposers,
     `getCordieriteState()` → `"idle"`, listeners never fire, `connect` rejects with
     `cordierite_disabled`. One source of truth for the API surface: derive both
     implementations from a shared interface type so they cannot drift (a
     type-level parity test like the existing `connect-options-parity.test.ts`).
2. **`useCordieriteTool(definition, deps?)`** — `useEffect` wrapper handling
   remount/fast-refresh churn (register on mount/deps change, dispose on cleanup;
   relies on task 11's identity-safe disposer).
3. **Schema exporter warning** — in `src/schema.ts`, when a provided Standard Schema
   lacks the JSON-Schema exporter (`~standard.jsonSchema` absent — zod 3, valibot),
   `console.warn` once per tool in `__DEV__` that agents will see a shapeless tool;
   still register with `{}`.
4. **Config plugin (`app.plugin.js`)**:
   - Validate pins: each must match `sha256/` + 44-char base64; throw a config error
     naming the offending value.
   - Write `allowPrivateLanOnly` in a form native actually reads (Boolean meta-data;
     coordinate with task 10's tolerant reader) and default it to `true` in the
     plugin schema (fail-closed alignment).
   - Add an option `deepLinkScheme?` that validates the scheme exists in the Expo
     config (warn if missing — the deep link silently dead-ends without it).
5. **Compile-out recipe** — document in `packages/react-native/README.md`: Metro
   `resolveRequest` snippet mapping `@cordierite/react-native` (and `/auto`) →
   `/noop` for release builds, plus the conditional-require alternative. Verify the
   noop path type-checks in a snippet test.
6. **Playground alignment is task 14** — do not update playground here beyond what
   compiling requires.

## Out of scope

- Client internals (done in 11). Playground rewrite (14). Docs beyond the package
  README (17).

## Acceptance criteria

- `import { registerTool } from "@cordierite/react-native"` in a test with **no**
  native module mocked does not throw at import time; calling `registerTool` then
  invoking a tool path that needs native fails with the actionable error.
- `/auto` import installs the bootstrap exactly once (existing
  `deep-link-bootstrap.test.ts` adapted); `/noop` passes the API-parity type test and
  its runtime no-op behavior is unit-tested.
- Plugin tests (extend or create `app.plugin` tests): valid/invalid pin, boolean
  meta-data written, defaults.
- `bun run lint/build/test` green; `bun run build` output contains the three entries
  and `package.json` `files`/`exports` cover them.

## Testing

Follow the existing bun-test + mocked-native patterns. For the plugin, test the pure
config-mutation functions directly (they're plain JS).
