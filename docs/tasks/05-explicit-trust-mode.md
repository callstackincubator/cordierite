# 05 — Explicit trust mode in the native clients

**Wave 1. Depends on 01. Runs in parallel with 04 (different files: this task owns
`CordieriteConnectionManager.{kt,swift}`; 04 owns `CordieritePackage.kt` and the iOS entry
files).**

## Goal

What the client trusts is a configuration value, not an inference from whether the build
happens to be debuggable.

## Why

This is the change that unblocks the project's core use case. Today, link-carried pin trust
requires a debuggable build, so the CI-driven "testing" variant — release-signed, internally
distributed — can never use it. It must instead embed `cliPins` at build time, per daemon
key, which forces either one key shared across CI runners (contradicting
`docs/SECURITY.md`'s one-key-per-machine rule) or a rebuild per runner.

Making trust explicit means a staging artifact can opt into zero-config link trust
deliberately, and a production artifact cannot get it by accident — the safety property
moves from "we guessed from the build type" to "someone wrote it down".

## Scope

Read `CordieriteTrust` (iOS `Info.plist`) / `com.callstackincubator.cordierite.TRUST`
(Android meta-data) alongside the existing pins keys. Values: `"link"` | `"pin"`.

Rewrite `resolveTrustedPins` on both platforms to take `(trust, embeddedPins, linkPin)`:

| `trust` | embedded pins | behavior |
| --- | --- | --- |
| `"pin"` | non-empty | embedded pins only; `linkPin` ignored |
| `"pin"` | empty | hard error — the plugin refuses this combination, so it means hand-edited native config |
| `"link"` | empty | trust `linkPin` for this session; error if the link carries none |
| `"link"` | non-empty | embedded pins win, `linkPin` ignored (unchanged from today: config can never *widen* trust) |

Missing key entirely → `"pin"` if pins are present, else `"link"`, matching the plugin's
default so bare-RN and Expo apps behave identically.

Remove every `isDebugBuild` / `FLAG_DEBUGGABLE` term from this path. Keep the tolerant
Boolean-or-String meta-data parsing pattern for the new String key (Android meta-data types
vary by how they were declared).

Keep the unconditional log when link trust is used, reworded — it is now a deliberate
configuration, not a dev-mode fallback:

```
Cordierite: trust=link — trusting the SPKI pin carried by the bootstrap link for this session.
```

## Naming

`"link"`, not `"all"`. `"all"` reads as "trust any certificate", which is not what happens:
the client still performs SPKI matching, just against a pin delivered by the link rather
than one baked in. Every doc line about it should say **TOFU per session, pinned to the
link's key** so nobody reads it as verification disabled.

## Acceptance

- Unit tests on both platforms cover all four rows of the table plus the missing-key
  defaults. `CordieriteConnectionManagerTest.kt` and
  `CordieriteConnectionManagerTests.swift` already have the fixtures pattern to extend.
- `git grep -n "isDebugBuild\|FLAG_DEBUGGABLE"` returns nothing in trust resolution.
- Parity test between platforms — the existing SPKI parity test is the model.
- Manual: a Release-signed playground build with `trust: "link"` connects from a fresh
  `cordierite link` with no pins configured anywhere.
