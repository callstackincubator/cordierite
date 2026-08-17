# Changelog

All notable changes to `cordierite`, `@cordierite/shared`, and `@cordierite/react-native` are
documented here. The three packages are versioned in lockstep (identical version numbers), so one
changelog covers all of them.

This file is maintained by hand. There is no automated changelog tooling (see
`docs/CI.md#release-policy` for why) — update this file as part of the commit that bumps the
package versions for a release.

## Unreleased (0.4.0)

0.4.0 is a rewrite of the CLI/daemon/protocol layer and is expected to contain breaking changes
for anyone on 0.3.x. Highlights since 0.3.1:

- **Breaking: daemon-based architecture ("protocol v2").** The CLI is now a thin RPC client to a
  background daemon process instead of talking to devices directly; the wire protocol, session
  engine, and invocation RPC surface were all rewritten.
- **Breaking: `enableInReleaseBuilds` removed from the React Native config plugin, with no
  deprecation shim.** Passing it at all (`true` or `false`) now throws at prebuild, naming
  `include`/`trust` as the replacement. Whether native code ships is decided purely by autolinking
  — present by default (`include: true`); set `include: false` on the plugin *and* exclude the
  package via `react-native.config.js` / `expo.autolinking` to compile it out. What a build trusts
  is decided by `trust` — `"pin"` when `cliPins` is configured, `"link"` otherwise (trust the SPKI
  pin carried by the bootstrap link, per session) — and is no longer tied to whether the build is
  debuggable. A 0.3.x config that set `enableInReleaseBuilds` (either value) must simply delete
  that option; see `packages/react-native/README.md`'s "Hardening for production / internal
  builds" and "Compiling Cordierite out of production builds" sections for the full migration.
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
