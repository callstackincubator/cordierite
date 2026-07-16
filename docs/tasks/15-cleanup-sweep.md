# 15 — Cleanup sweep & release prep

> Status: done (994335f)

## Goal

A repo-wide consistency pass now that all v2 pieces have landed: verify no v1
residue survived, prune unused dependencies, align versions, and stamp the interim
docs. Small task by design — a fresh pair of eyes over the accumulated diff.

## Depends on

06, 11, 12, 14 (all packages in their v2 shape).

## Read first

- `docs/ARCHITECTURE.md` §13 (target layout — compare against reality).
- Each package's `index.ts` / `exports` map and `package.json`.

## Scope

1. **Residue sweeps** (fix anything these surface; they should already be clean —
   tasks 01/02 did the deletions):
   - `git grep -iE "session_registry|remote-control|cordierite host\b|host-reporters"`
     → hits only in `docs/tasks/` and git history.
   - `git grep "0x01" packages/` → no bootstrap-version hits.
   - `git grep "protocol_version" packages/` → v2-only.
   - `git grep -n "addCordieriteErrorListener" packages/` → nothing.
   - `git ls-files "*.pem"` → empty.
2. **Export surface review** — read each package's public exports against
   ARCHITECTURE §13 and the package READMEs: no accidentally-exported internals, no
   dead re-exports, `@cordierite/shared` still has zero runtime deps.
3. **Dependency prune** — for each `package.json`, remove dependencies nothing
   imports anymore (v1 leftovers); refresh `bun.lock`. Run `bunx knip` (or a manual
   import audit if knip fights the RN package) and act on real findings only.
4. **Version alignment** — bump all three packages to `0.4.0-rc.1` (this is the
   protocol cut-over release); confirm `app.plugin.js` and `android/build.gradle`
   pick the version up per task 01's sync mechanism.
5. **Interim doc banners** — `docs/HANDSHAKE.md` and `docs/REQUIREMENTS.md` still
   describe v1: add a one-line banner at the top of each pointing to
   `ARCHITECTURE.md` as current. (Full rewrite is task 17 — do not rewrite here.)
6. **Duplicate-helper check** — grep for copy-pasted validation/formatting helpers
   that accumulated across daemon/CLI/MCP during tasks 03–13 (session-selector
   parsing, base64url helpers, JSON rendering); consolidate obvious duplicates into
   one location each. Behavior-preserving moves only.

## Out of scope

- New features, behavior changes, doc rewrites (17), E2E additions (16).
- Publishing/tagging.

## Acceptance criteria

- All sweeps in item 1 pass.
- `bun run clean && bun install && bun run build && bun run test && bun run lint`
  green from root.
- Each removed dependency is named in the commit body with why it's dead.
- All three `package.json` files read `0.4.0-rc.1`.

## Testing

No new behavior — the full suite staying green after prunes/moves is the test. If a
dependency removal breaks something, it wasn't dead: restore it and move on.

> Status: DONE. Residue sweeps clean. Removed dead `zod` devDependency (react-native
> package, unused since task 12) and the leftover `export * from "./commands/keygen.js"`
> re-export in `cordierite`'s package root (pre-refactor v1 leftover, nothing depended
> on it). No duplicate helpers found (selector resolution, base64url, JSON rendering
> already single-sourced). Bumped all three packages to `0.4.0-rc.1` and the Android
> gradle sync comments. Added v1 banners to HANDSHAKE.md/REQUIREMENTS.md.
