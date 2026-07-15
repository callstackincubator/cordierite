# 07 — Emulator/simulator fast path (`link --open`)

## Goal

Zero-friction bootstrap for emulators and simulators: `cordierite link --open
android|ios-sim` delivers the deep link automatically so CI and agents never handle a
QR code. This is the primary automation path (ARCHITECTURE §8, delivery path 1).

## Depends on

06.

## Read first

- `docs/ARCHITECTURE.md` §8 (delivery paths), §10 (`link` flags).
- v1 context (deleted in task 01): the old `--open` was iOS-simulator-only and just
  ran `xcrun simctl openurl booted <link>`; v2 generalizes this to both platforms.

## Scope

New module `packages/cordierite/src/cli/open-target.ts` + wiring into `link`:

1. **`--open ios-sim`**
   - Advertised address forced to `127.0.0.1` (the simulator shares the host network):
     pass an address override to `link.create` (add an optional
     `addressOverride` param to the RPC method — daemon encodes it into the payload;
     the wss listener already binds all interfaces).
   - Deliver: `xcrun simctl openurl booted '<deepLink>'`. Preflight: `xcrun simctl
     list devices booted` must show ≥1 booted device, else a clear error.
2. **`--open android`**
   - Run `adb reverse tcp:<wssPort> tcp:<wssPort>` so the emulator/USB device reaches
     the daemon at `127.0.0.1:<wssPort>`; advertised address forced to `127.0.0.1`.
   - Deliver: `adb shell am start -a android.intent.action.VIEW -d '<deepLink>'`
     (single-quote the URL for the device shell; `am start` mangles unescaped `&` —
     the payload is a single query param so this is safe, but test it).
   - Multiple devices attached: honor `ANDROID_SERIAL` / add `--device <serial>`;
     if ambiguous, list serials and error.
   - Note in help/docs: `adb reverse` works for USB-attached physical devices too.
3. **Process execution** — run subprocesses via an injectable exec seam (tests stub
   it); command-not-found (`adb`/`xcrun` missing) → actionable error naming the tool;
   non-zero exits surface stderr.
4. `--open` combined with `--json`: emit `{ …link fields, delivered: true,
   target: "android"|"ios-sim" }` after successful delivery.

## Out of scope

- Physical-device-over-LAN delivery (QR path already exists).
- Windows `adb.exe` peculiarities beyond using the name `adb` from PATH.

## Acceptance criteria

- Unit tests with a stubbed exec seam cover: happy path per target (correct argv,
  correct ordering `adb reverse` before `am start`), no booted simulator, missing
  binary, multiple android devices without `--device`, `--device` passthrough as
  `adb -s <serial> …`.
- The deep link passed to both targets contains an address-family byte for
  `127.0.0.1` (decode the payload in the test and assert the address).
- `bun run lint/build/test` green.

## Testing

All logic must be testable without adb/xcrun installed (exec seam). If you have a
booted emulator/simulator available, do one manual smoke run and note the result in
the commit message body — but CI-independence is the requirement.

> Status: DONE. See `task(07)` commit.
