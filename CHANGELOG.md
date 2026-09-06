# Changelog

All notable changes to `cordierite`, `@cordierite/shared`, and `@cordierite/react-native` are
documented here. The three packages are versioned in lockstep (identical version numbers), so one
changelog covers all of them.

This file is maintained by hand. There is no automated changelog tooling (see
`docs/CI.md#release-policy` for why) — update this file as part of the commit that bumps the
package versions for a release.

## Unreleased

- **New: the CLI and MCP server detect a daemon left running on an older version, and restart it
  when that is safe.** The daemon is long-lived and never exits on its own, so
  `npm i -g cordierite@<newer>` left every later command talking to the previous build — a 0.6.0
  CLI against a 0.5.x daemon got an opaque "method not found" for `cordierite events --since` or
  `cordierite_wait_for_event`, with nothing pointing at `cordierite daemon stop`. Each CLI/MCP
  process now compares `daemon.status`'s `version` with its own once, on its first connection
  (cached per daemon socket, so one extra round-trip per process, not per request). Versions are
  compared as semver and only a client *newer* than the daemon replaces it — a newer daemon already
  serves an older client, and downgrading it would break whichever install started it. With nothing
  live the daemon is replaced transparently, at most once per process; when there is live state to
  lose the command fails with a `connection_error` naming both versions and what would go. "Live
  state" is connected sessions (resume tokens live in daemon memory, so a restart makes an app's
  resume fail closed with 1008) and links that are still claimable — for which `daemon.status`
  gains a `pendingLinks` count. Force the restart with the new global `--daemon-restart` flag,
  `CORDIERITE_DAEMON_RESTART=1`, or `config.json`'s new `restartDaemonOnVersionMismatch`;
  `--no-daemon-restart` overrules the latter two for one command. `cordierite daemon status` reports
  drift as a warning and never restarts the daemon it was asked about; `daemon run`/`stop`,
  `keygen`/`doctor`, and the `cordierite/client` test SDK opt out entirely. See
  `docs/ARCHITECTURE.md` §4, "Version drift".
- **New: `inputSchema`/`outputSchema` accept a `{ schema, jsonSchema }` pair and raw JSON
  Schema objects.** Previously a tool schema had to be a Standard Schema *and* implement the
  non-standard `~standard.jsonSchema` exporter to give agents a real shape; zod 3 and plain
  valibot implement the first but not the second, so those tools registered with no
  `input_schema` and reached the agent as `{ type: "object", additionalProperties: true }`.
  Standard Schema remains the only runtime-validation contract, but the two slots now accept:
  a Standard Schema (as before); a `{ schema, jsonSchema }` pair, where `jsonSchema` is a JSON
  Schema object or an `{ input, output }` converter — the supported path for zod 3
  (`zod-to-json-schema`) and valibot (`@valibot/to-json-schema`); or a raw JSON Schema object,
  detected by the absence of `~standard` and required to be a plain object whose `type`, if
  present, is a JSON Schema type name, published verbatim and passed to the handler
  unvalidated. A Standard Schema may be an object or a callable, so arktype's `Type` is
  accepted. Anything that is none of the three — a class instance, an object mentioning
  `schema`/`jsonSchema` that is not a valid pair — throws a `TypeError` at registration
  instead of being published as the tool's shape. Handler argument/result inference is unchanged for zod 4, follows the pair's
  `schema` for pairs, and is `Record<string, unknown>` for a bare raw schema or `T` when
  tagged with the new type-level `jsonSchema<T>()` helper. No runtime dependency was added:
  Cordierite still bundles no JSON Schema validator, which is why a raw schema is not enforced.
  The wire `ToolDescriptor` is unchanged, so this is app-side only.
- **Breaking (development only): a Standard Schema that exports no JSON Schema now throws in
  `__DEV__`.** `registerTool`/`useCordieriteTool` used to accept a bare zod 3 or plain valibot
  schema, emit a dev warning, and register the tool with no schema at all — a silent failure,
  since the tool looked registered but no agent could work out what to pass it. That case now
  throws a `TypeError` naming the two supported forms above. The same applies to every other
  way a slot can end up shapeless, which previously all returned quietly: an exporter or a
  paired converter that throws, or that returns something other than a JSON Schema object.
  **Release builds are unaffected in kind**: the tool still registers without a schema, now
  with one `console.warn` per tool name (previously dev-only), so an app already shipping
  such a tool is not broken by upgrading. Fix by pairing the schema with a JSON Schema, or
  passing raw JSON Schema.
- **Type change:** `CordieriteRuntimeSchema` is now a union of the three accepted forms rather
  than an alias for `StandardSchemaV1`, and `CordieriteRegisteredTool.inputSchema`/
  `.outputSchema` hold the normalized `CordieriteNormalizedToolSchema` rather than the raw
  user value. Both matter only to code that inspected those internal types directly.
  `requireStandardSchema`/`requireOptionalStandardSchema`/`validateStandardSchema` (never part
  of the documented surface) are replaced by `normalizeToolSchema`/
  `normalizeOptionalToolSchema`/`validateToolSchema`.

## 0.7.0 (2026-08-19)

- **Fix: a terminal daemon rejection (1008) now ends the session instead of retrying until
  grace.** `onSocketLost` previously treated only close code 1000 as terminal, so an
  unretryable rejection — `unknown_session` after a daemon restart, `invalid_resume_token`, a
  session revoked or expired while offline — kept the client in `reconnecting` for up to
  `grace_s` (600s default) before its `sessionChange: lost` listener ever fired. Every
  daemon-side rejection of this kind closes with 1008, so 1008 is now terminal wholesale rather
  than matched by reason string; transport-level closes (1011, 1001, 1006) stay retryable. A
  failed resume's close code now travels with the rejection via
  `CordieriteHandshakeClosedError` so it isn't thrown away before reaching `onSocketLost`.
- **Fix: `restoreSession()` is now a first-class export**, reachable without going through
  `installCordieriteDeepLinkBootstrap` or the `cordieriteClient` proxy. An app that drives
  bootstrap itself (custom deep-link routing, QR scanning, a manual `connect()`) had nothing
  reading the native lease, so every Metro reload dropped a session native could still have
  resumed. Exported from the root and `./noop` entries and `CordierePublicApi`.
- **Breaking: `requirePrivateIp` is removed; `/auto` is now the only install path.**
  `allowPrivateLanOnly` was already native build config
  (`CordieriteAllowPrivateLanOnly` in Info.plist / the Android manifest) enforced by native
  `connect()` on both platforms — the JS `requirePrivateIp` option could only narrow what
  native already allowed, so setting it to `false` without also setting the native key did
  nothing. The deep-link handler now reads `allowPrivateLanOnly` from the same
  `getConstants()` path native enforces from, failing closed when it can't be read.
  `installCordieriteDeepLinkBootstrap` and `InstallCordieriteDeepLinkBootstrapOptions` are gone;
  `require("@cordierite/react-native/auto")` is the only way to install the bootstrap listener
  now. See `packages/react-native/README.md` for the current surface.

## 0.6.0 (2026-08-18)

- **New: tool call cancellation.** A new `tools.cancel` RPC and `tool_cancel` wire frame let a
  caller cancel a still-pending `tools.call` instead of waiting it out. The RN SDK's
  `tool.handler(args, context)` now receives an `AbortSignal` on `context.signal`, aborted on a
  `tool_cancel` frame or when the session's transport is lost; a handler that ignores it keeps
  running as before, one that observes it and throws gets `tool_cancelled` reported (distinct from
  `tool_timeout`). `cordierite invoke` cancels the in-flight call on SIGINT rather than leaving the
  app-side handler running for a caller that already exited. An MCP client's
  `notifications/cancelled` maps to `tools.cancel` automatically.
- **New: daemon-side event retention and a pull surface (`events.since`).** The daemon now keeps a
  per-session ring buffer (`eventBufferSize`, default 256) of recent events, including
  `app_event`s posted from the app. `events.since` drains it by sequence cursor, so a caller that
  wasn't subscribed at the moment an event fired can still retrieve it. Two new MCP tools expose
  this to agents: `cordierite_events` (pull) and `cordierite_wait_for_event` (block for a matching
  event, checking the retained buffer before falling back to a live wait).
- **New: minimal `"prompt"` policy value.** `policy.default`/`policy.destructive`/per-tool
  overrides now accept `"prompt"` in addition to `"allow"`/`"deny"`. The only implemented gate
  today is MCP: a compliant client (Claude Code ≥ v2.1.199) gets
  `_meta["anthropic/requiresUserInteraction"]` on `tools/list` for a `"prompt"` tool and echoes
  consent back on `tools/call`; every other caller (CLI, an older/non-compliant MCP client, CI) is
  denied with `policy_denied` — `"prompt"` fails closed rather than behaving like `allow`. See
  `docs/SECURITY.md` for what this does and doesn't guarantee.
- **New: `cordierite/client` programmatic API for test runners.** A typed wrapper over the same
  daemon RPC the CLI and MCP server use, for a Jest/Vitest/Detox spec that wants to drive a
  running app without shelling out to `cordierite invoke --json`: `connect()`, `link()` +
  `waitForSession()`, `app.call()`, `app.tools()`, `app.events()`/`app.waitForEvent()`. Errors
  surface as a `CordieriteError` whose `type` preserves the daemon's wire error type, so tests can
  assert on it directly. See `packages/cordierite/README.md`'s "Programmatic use" section.

## 0.5.1 (2026-08-17)

- **Fix: release builds no longer carry Cordierite's native module by default.** Previously,
  leaving `CORDIERITE_ENABLED` unset shipped Cordierite in every build variant, including
  release — the opposite of the intended dev-only default. Unset now links only `Debug`/`debug`,
  `1`/`true` links every variant (for a release-signed internal/QA build that still needs
  Cordierite), and `0`/`false` excludes it everywhere, unchanged. iOS: `react-native.config.js`
  sets CocoaPods' `:configurations`, a real per-variant linking decision. Android: RNGP's
  generated `PackageList.java` is shared, unfiltered, across every variant, so the equivalent
  `buildTypes` restriction breaks compilation for a package with static Java registration
  instead — `android/build.gradle` instead swaps which Kotlin source set compiles for `release`
  (the real implementation, or a no-op `CordieritePackage` at the same fully-qualified name),
  keyed on the same `CORDIERITE_ENABLED`. Neither mechanism is a runtime check.
- **Fix: `cordierite doctor`'s Android detection now requires the `CordieriteNativeMarker`
  keep-rule signal to report `present`.** The no-op stub introduced by the fix above compiles at
  the real implementation's exact package name, and the config plugin writes the same
  `AndroidManifest.xml` meta-data regardless of build variant — so the two other Android
  signals (dex package-string, manifest meta-data keys) could otherwise report a harmless
  default-release stub as "present." They're still reported for corroboration but no longer
  independently decide the verdict.
  See `packages/react-native/README.md`'s "Compiling Cordierite out of production builds" for the
  updated matrix.

## 0.5.0 (2026-08-17)

A rewrite of the CLI/daemon/protocol layer, shipped as 0.5.0 rather than the originally planned
0.4.0 (see `docs/CI.md#release-policy`). Contains breaking changes for anyone on 0.3.x. Highlights
since 0.3.1:

- **Breaking: daemon-based architecture ("protocol v2").** The CLI is now a thin RPC client to a
  background daemon process instead of talking to devices directly; the wire protocol, session
  engine, and invocation RPC surface were all rewritten.
- **Breaking: `enableInReleaseBuilds` removed from the React Native config plugin, with no
  deprecation shim.** Passing it at all (`true` or `false`) now throws at prebuild, naming the
  replacement. Whether native code ships is decided by autolinking alone, driven by the
  `CORDIERITE_ENABLED` environment variable: unset or empty means included (so a build that never
  mentions Cordierite still gets it), `0`/`false` opts the package out of autolinking on both
  platforms, and any other value is a config error. The package ships its own
  `react-native.config.js` that reads it, and `@cordierite/react-native/metro` reads the same
  variable to strip the JS, so one pipeline variable removes both surfaces with no app-side config.
  It must be set when autolinking resolves (`pod install` / gradle configure), not merely when the
  app compiles. What a build trusts is decided by `trust` — `"pin"` when `cliPins` is configured,
  `"link"` otherwise (trust the SPKI pin carried by the bootstrap link, per session) — and is no
  longer tied to whether the build is debuggable. A 0.3.x config that set `enableInReleaseBuilds`
  (either value) must simply delete that option; see `packages/react-native/README.md`'s
  "Hardening for production / internal builds" and "Compiling Cordierite out of production builds"
  sections for the full migration.
- **When Cordierite is linked, its podspec and `build.gradle` print `[cordierite] native module
  INCLUDED in this build`** during pod install / gradle configure. Nothing prints when it is
  excluded, because nothing runs — the line exists to catch a release build that carries
  Cordierite by mistake. `cordierite doctor` remains the authority, since it inspects the built
  artifact rather than the build log.
- **New:** `cordierite doctor <artifact>` — inspects a built `.app`/`.ipa`/`.apk`/`.aab` directly
  to assert whether Cordierite is present or absent, replacing the old runtime `debuggable`/`#if
  DEBUG` check as the release-gate mechanism.
- **New:** `cordierite mcp` — an MCP server exposing Cordierite sessions to MCP-compatible tools.
- **New:** emulator/simulator fast path (`cordierite link --open`).
- **New:** session recovery on iOS and Android — the native clients can resume a session across an
  app process restart (resume lease) instead of requiring a fresh bootstrap link.
- **New:** daemon-side policy engine and audit log.
- **Hardened:** iOS and Android native connection layers no longer contain any build-type
  (`debuggable`/`#if DEBUG`) check at all; whether Cordierite's native code is present in a build
  is decided solely by autolinking, independent of debuggability, and is verifiable directly
  against a built artifact with `cordierite doctor`.
- **Tooling:** migrated the workspace from bun to pnpm + vitest; CI now pins all GitHub Actions to
  full commit SHAs and publishes via npm trusted publishing (OIDC + provenance).

This list is a summary, not a full commit log — see `git log` for exact detail.

## 0.3.1 and earlier

Published to npm (0.1.0, 0.2.0, 0.3.0, 0.3.1) but not documented in a changelog. Consult the git
history predating the 0.4.0 rewrite (everything before `task(01): delete v1 host model and fix
repo hygiene`) for what shipped in those releases.
