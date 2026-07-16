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
   deep-link bootstrap listener automatically. (If you'd rather drive bootstrap
   yourself — custom deep-link handling, QR scanning, tests — import the side-effect-free
   root entry instead and call `installCordieriteDeepLinkBootstrap()` when ready.)
5. Generate a TLS private key for the daemon. For a new setup, run `cordierite keygen`
   (non-interactive with `--out <path>`; writes `~/.cordierite/key.pem` by default).
6. Add the matching `sha256/...` SPKI pin to the app configuration, in a `cliPins` array
   (plural — the native clients accept a pin *set*, which is what makes future rotation
   non-breaking). Use the fingerprint printed by `cordierite keygen`.
7. Optional: use `addCordieriteListener("error", ...)` to observe bootstrap parse
   failures, connect failures, or socket errors — one unified channel for all of them.
8. Advanced: use `getCordieriteState()` / `addCordieriteListener("stateChange", ...)` for
   manual connection-state UI.
9. Production builds that shouldn't ship Cordierite at all should import
   `@cordierite/react-native/noop` instead (see the package README's compile-out
   recipe) rather than relying on a runtime flag.

## Expo

1. Add `@cordierite/react-native` to the app dependencies.
2. Add the Cordierite Expo config plugin to the Expo config with `cliPins` (required)
   and, optionally, `allowPrivateLanOnly` (defaults to `true`, fail-closed) and
   `deepLinkScheme`.
3. Make sure `deepLinkScheme` (or `expo.scheme`) matches the scheme you'll pass to
   `cordierite link --scheme ...` (or set once in `~/.cordierite/config.json`'s
   `"scheme"` field).
4. Run prebuild or rebuild the native project so the native config is applied.
5. Use a development build. Expo Go is not enough — this library ships native code.

## Bare React Native

1. Add `@cordierite/react-native` to the app dependencies.
2. Run the normal native dependency installation steps for the project.
3. Add the trusted daemon pins to native configuration on iOS and Android (see the
   package README's "Bare React Native — native keys" table).
4. Add the optional private-LAN-only setting only if the project wants that restriction.
5. Configure URL schemes / intent filters so bootstrap links (`{scheme}:///?cordierite=…`)
   open your app.
6. Rebuild the native app after the configuration changes.

## Final check

- The daemon (`~/.cordierite/key.pem` by default) has a readable, `0600` private key.
- The app trusts the daemon's current pin in `cliPins`.
- The app has at least one registered tool.
- The app scheme matches the scheme `cordierite link` will use to compose the deep link.
- `cordierite ls` (or `cordierite_connect` + `cordierite_wait_for_session` over MCP)
  reaches `state: "active"` once the app opens the link.
