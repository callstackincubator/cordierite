# Cordierite setup

Use this file when the task is to add Cordierite to a new React Native project.

## Shared requirements

1. Install `cordierite` where the operator or agent will run the CLI (or configure it as
   an MCP server — see the main skill file). Its daemon auto-spawns on first use; there
   is no separate host process to start.
2. Install `@cordierite/react-native` in the app.
3. Register the app tools you want Cordierite to expose (`registerTool` /
   `useCordieriteTool`).
4. Import `@cordierite/react-native/auto` once near the app's entry point to install the
   deep-link bootstrap listener automatically — or `require()` it at the point you want
   it installed (e.g. behind `__DEV__`). (If you'd rather drive bootstrap yourself —
   custom deep-link handling, QR scanning, tests — skip that entry, use the
   side-effect-free root entry, and call `restoreSession()` at startup before your own
   bootstrap handling so a Metro reload still recovers the session.)
5. Optional, for pinned trust: generate a TLS private key for the daemon with
   `cordierite keygen` (non-interactive with `--out <path>`; writes `~/.cordierite/key.pem`
   by default). Skipping this is fine — the daemon generates its own key on first start and
   `cordierite link` carries the fingerprint on the deep link.
6. If you generated a key in step 5, add its `sha256/...` SPKI pin to the app
   configuration, in a `cliPins` array (plural — the native clients accept a pin *set*,
   which is what makes future rotation non-breaking). Configuring `cliPins` switches the
   build to `trust: "pin"`, so the link-carried pin is ignored from then on
   (`docs/SECURITY.md`, "Trust modes").
7. Optional: use `addCordieriteListener("error", ...)` to observe bootstrap parse
   failures, connect failures, or socket errors — one unified channel for all of them.
8. Advanced: use `getCordieriteState()` / `addCordieriteListener("stateChange", ...)` for
   manual connection-state UI.
9. Production builds that shouldn't ship Cordierite at all should be built with
   `CORDIERITE_ENABLED=0` rather than gated by a runtime flag. That variable drops the
   native module on its own.
10. To strip Cordierite's JS as well, wrap the app's Metro config in the
   `withCordierite` helper from `@cordierite/react-native/metro` (call it last, after
   anything else that sets `resolver.resolveRequest`). Without that wiring the real JS
   entry is still bundled; it just finds no native module and goes inert. See
   `docs/BUILD-VARIANTS.md`.

## Expo

1. Add `@cordierite/react-native` to the app dependencies.
2. Optional: add the Cordierite Expo config plugin to the Expo config. `cliPins` is
   required only when `trust: "pin"` is set or implied; `trust`, `allowPrivateLanOnly`
   (defaults to `true`, fail-closed) and `deepLinkScheme` are optional. A zero-config app
   can skip the plugin entry entirely (`docs/SECURITY.md`, "Configuring trust").
3. Make sure `deepLinkScheme` (or `expo.scheme`) matches the scheme you'll pass to
   `cordierite link --scheme ...` (or set once in `~/.cordierite/config.json`'s
   `"scheme"` field).
4. Run prebuild or rebuild the native project so the native config is applied.
5. Use a development build. Expo Go is not enough — this library ships native code.

## Bare React Native

1. Add `@cordierite/react-native` to the app dependencies.
2. Run the normal native dependency installation steps for the project.
3. For pinned trust, add the trusted daemon pins to native configuration on iOS and
   Android (see `docs/SECURITY.md`'s "Bare React Native — native keys" table).
4. Add the optional private-LAN-only setting only if the project wants that restriction.
5. Configure URL schemes / intent filters so bootstrap links (`{scheme}:///?cordierite=…`)
   open your app.
6. Rebuild the native app after the configuration changes.

## Final check

- The daemon (`~/.cordierite/key.pem` by default) has a readable, `0600` private key.
- The app trusts the daemon's current pin — via `cliPins` for a pinned build, or via the
  link-carried pin when no `cliPins` are configured.
- The app has at least one registered tool.
- The app scheme matches the scheme `cordierite link` will use to compose the deep link.
- `cordierite ls` (or `cordierite_connect` + `cordierite_wait_for_session` over MCP)
  reaches `state: "active"` once the app opens the link.
