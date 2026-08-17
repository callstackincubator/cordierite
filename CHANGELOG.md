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
- **Breaking: explicit release-build trust model.** The React Native config plugin now requires
  opting in via `enableInReleaseBuilds`; native clients trust a bootstrap link's pin only in
  debug/debuggable builds unless a trust config value is explicitly provided. Builds that used to
  rely on debug-only exclusion must migrate — see `docs/` for the migration notes shipped
  alongside this change.
- **New:** `cordierite doctor <artifact>` — inspects a built `.app`/`.ipa`/`.apk`/`.aab` directly
  to assert whether Cordierite is present or absent, replacing the old runtime `debuggable`/`#if
  DEBUG` check as the release-gate mechanism.
- **New:** `cordierite mcp` — an MCP server exposing Cordierite sessions to MCP-compatible tools.
- **New:** emulator/simulator fast path (`cordierite link --open`).
- **New:** session recovery on iOS and Android — the native clients can resume a session across an
  app process restart (resume lease) instead of requiring a fresh bootstrap link.
- **New:** daemon-side policy engine and audit log.
- **Hardened:** iOS and Android native connection layers; autolinking-gated inclusion so Cordierite
  can be verifiably excluded from release builds; default-inert behavior in release builds absent
  explicit opt-in.
- **Tooling:** migrated the workspace from bun to pnpm + vitest; CI now pins all GitHub Actions to
  full commit SHAs and publishes via npm trusted publishing (OIDC + provenance).

This list is a summary, not a full commit log — see `git log` for exact detail.

## 0.3.1 and earlier

Published to npm (0.1.0, 0.2.0, 0.3.0, 0.3.1) but not documented in a changelog. Consult the git
history predating the 0.4.0 rewrite (everything before `task(01): delete v1 host model and fix
repo hygiene`) for what shipped in those releases.
