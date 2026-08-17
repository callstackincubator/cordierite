# 11 — Investigate the pre-existing bootstrap-decode failure

**Independent of this series. Can be picked up at any time by anyone.**

## Goal

`packages/cordierite/src/__tests__/exit-codes.integration.test.ts` passes, or the test is
knowingly changed for a documented reason.

## Why

```
FAIL  exit-codes.integration.test.ts > exit codes: v2 command surface >
      tool_error (72): invoke a name not registered on a real, claimed session
      → decodeBootstrap(linkPayload) returned null, expected non-null
```

This failure predates every task in this directory. Four separate agents independently
confirmed it reproduces on a clean `feat/opt-in-hardening`, and each was told to ignore it so
it would not be mistaken for their own regression.

It is filed rather than ignored because of what it touches. `decodeBootstrap` returning
`null` means a minted bootstrap payload failed to round-trip through the decoder — the exact
path every device claim depends on, and the path this series' trust work (task 05) sits
directly on top of. It is very likely a test-harness or fixture problem rather than a
protocol bug, since the e2e suites that exercise real claims pass. "Very likely" is not
"verified", and a red test in the suite trains everyone to ignore red tests.

## New evidence — it is load-dependent, and it is spreading

After wave 2 merged, a **second** test began failing in the same full-suite run:
`tool-invocation.integration.test.ts > app tool_error type tool_not_found is preserved
verbatim end-to-end`. Run on its own, that file passes 16/16 — twice, consecutively. So the
failure is not deterministic; it appears only under the full suite's parallel load, on a run
that takes ~46 s.

That reframes the diagnosis. Both failing tests mint a bootstrap link and then claim a real
session, and the payload carries `expiresAt` in unix **seconds**. A fixture minted with a
short TTL that decodes fine on a fast, isolated run will decode to `null` once the suite is
slow enough for the link to expire first. Check that hypothesis before anything else.

The reason this now matters more: an intermittent failure that grows to a second test is how
a suite stops being trusted. It was already being routinely waved through — five agents in
this series were each told to ignore it.

## Scope

- Root-cause it. Start by determining whether the payload is malformed at mint time or
  mis-parsed at decode time — `packages/shared/src/domains/bootstrap.ts` and the fixtures in
  `packages/cordierite/src/__tests__/fixtures.ts` are the two ends.
- Check whether it is timing/TTL-dependent: the payload carries `expiresAt` in unix
  **seconds**, and a fixture minted with a short or already-elapsed TTL would decode to
  `null` in exactly this way.
- Fix the root cause, or — if the test's expectation is genuinely wrong — change the test and
  say why in the commit message.

## Acceptance

- `pnpm test` in `packages/cordierite` is fully green.
- The commit message states what the cause was, so the next person who sees a `decodeBootstrap`
  null does not re-derive it.
