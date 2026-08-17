# 09 — Docs, migration, and CI

**Wave 3. Depends on every other task. Land last, once behavior is settled.**

## Goal

The documentation describes the design that exists, and CI enforces the parts that can
silently rot.

## Why

Three of the four problems in `00-overview.md` were found by reading the docs against the
code, and one of them (task 02) was a recipe that had never worked. This design leans harder
on documentation than the old one did — the inclusion switch now lives in the app author's
`package.json`, not in our native code — so the docs are load-bearing, not descriptive.

## Documentation scope

**`README.md`**

- Replace "Hardening for production / internal builds" and the behavior matrix. The new
  matrix is not build-type-keyed: it is `include` × `trust`.
- Rewrite the migration section against **`0.3.1`**, the actual published baseline.
  `enableInReleaseBuilds` never shipped, so the intermediate state the current section
  describes never existed for any user. The real migration for a `0.3.1` user is: nothing
  changes by default; add `trust`/`cliPins` if you were already pinning; add the autolinking
  exclude if you want it stripped.
- Correct the "Inert by default in release builds" bullet in the Security list — inertness
  is no longer the default; *inclusion is an explicit app-level choice*, which is a
  different and stronger claim.

**`docs/ARCHITECTURE.md` §11**

- Replace the default-inert/dev-trust paragraph. Note that it currently contradicts itself
  ("app-target settings … added to the Cordierite pod's Release configuration") and is wrong
  about `Release` specifically — good evidence for keeping the replacement short.
- Document the JS half (`noopIfNativeUnavailable`, `/noop`, Metro swap) as the JS-layer
  strip, distinct from the native-layer strip.

**`docs/SECURITY.md`**

- Rewrite "Dev trust mode" as **trust modes** — `link` vs `pin` as configuration, with the
  TOFU-per-session framing and the residual-risk analysis retained (it is good and still
  applies).
- Delete "Three release-build locks" — all three are gone. Replace with what actually
  contains link trust now: it is opt-in configuration, inclusion is a separate explicit
  choice, and `cordierite doctor` verifies the result.
- Reclassify policy/audit honestly: **operator ergonomics, not a production control**, since
  they run on the machine this document already names as the trust boundary. Point at
  conditional registration (task 03) as the app-side control that sits inside the boundary.
- Fix the exclusion recipe if task 02 did not already.

**`packages/react-native/README.md`** — options table, the `enabled` recipe, the
`package.json` exclusion recipe, and `getCordieriteBuildConfig`.

**`docs/REQUIREMENTS.md`** — "Current product shape" and the production-capable goal.

## CI scope (`docs/CI.md` + workflows)

- Run `cordierite doctor --assert-present` against the playground's Release build, and
  `--assert-absent` against a build with the exclude applied. This is the regression test
  for the entire design; without it, task 02's failure mode returns silently.
- Keep native unit tests for both platforms running (task 04 deletes some, task 05 adds
  others).

## Acceptance

- No document references `enableInReleaseBuilds`, `ENABLE_IN_RELEASE`,
  `CORDIERITE_ENABLE_RELEASE`, or describes trust as derived from the build type.
- Both exclusion recipes are correct and verified by CI, not by inspection.
- A reader can answer, from the README alone: will Cordierite be in my production build, and
  if it is, what does it trust?
