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
