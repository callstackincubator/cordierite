# 14 — Playground update

## Goal

Make the playground the reference consumer of the v2 SDK and the manual test bed for
the daemon flow: dynamic tool list, event posting, resume behavior visible, and
setup docs that match v2.

## Depends on

06 (CLI), 11, 12 (SDK). Native tasks 09/10 should be merged for on-device behavior.

## Read first

- `docs/ARCHITECTURE.md` §10, §11.
- `playground/app/` (expo-router tabs; `(tabs)/index.tsx` currently hardcodes the
  tool list at ~:187-193 and hand-writes registration effects at ~:70-107),
  `playground/app.json` (plugin config), `playground/README.md`.

## Scope

1. **Bootstrap** — switch to the v2 entries: `import "@cordierite/react-native/auto"`
   in the root layout (or an explicit `installCordieriteDeepLinkBootstrap` call —
   pick the auto entry to exercise it).
2. **Tools screen** —
   - register the demo tools with `useCordieriteTool` (replace the hand-written
     effects), including at least: `sum` (schemas), one tool with
     `annotations.destructiveHint` (e.g. `reset_counter`), one slow tool that reports
     `tool_call_progress`, and one that throws (exercises `tool_execution_error`).
   - render the registered tool list from the client's own registry (add a
     `getRegisteredTools()` export in the SDK if task 11/12 didn't — trivial getter),
     not a hardcoded array.
3. **Status screen** — connection state + alias via `addCordieriteListener`
   (`stateChange`, `sessionChange`), an error feed from the unified `error` listener,
   and a button that calls `postEvent("playground_ping", { at: Date.now() })`.
4. **Config** — `app.json`: plugin entry with placeholder pin
   (`sha256/REPLACE_WITH_KEYGEN_OUTPUT`), `allowPrivateLanOnly: true`, scheme set;
   remove any stale v1 keys.
5. **README** — rewrite the run instructions for v2:
   `cordierite keygen` → paste pin → `bun expo run:ios|android` →
   `cordierite link --open ios-sim` (or `--qr` for a device) → `cordierite ls` /
   `invoke` / `events --follow`; note the Metro-reload-and-resume behavior as a thing
   to try.

## Out of scope

- Visual polish. New screens beyond the two above. E2E automation (task 16).

## Acceptance criteria

- `bun install && bun run build` at root stays green; playground type-checks
  (`tsc --noEmit` via its lint/test setup).
- Manual smoke (document the run in the commit body): iOS simulator or Android
  emulator — link via `--open`, tools appear in `cordierite tools`, `invoke sum`
  returns, destructive tool denied when the daemon config says so, Metro reload →
  session suspends and resumes without re-linking, `events --follow` shows the
  `playground_ping` event.

## Testing

Playground has no test suite; the deliverable is the documented manual smoke plus
keeping workspace builds green. Any SDK gap discovered here (e.g. missing
`getRegisteredTools`) is fixed in the SDK package within this task, with a unit test
there.

> Status: DONE. `bun install/build/test/lint` green at root; playground type-checks via
> a new `tsc --noEmit` in its `lint`/`test` scripts. Manual on-device/simulator smoke
> not run in this environment (no simulator/emulator available) — see final report for
> the "not verified" breakdown.
