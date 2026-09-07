# Cordierite setup

Use this file when the task is to add Cordierite to a new React Native project.

The development path needs **no keys, no pins and no config file**. The daemon generates
its own host key on first start, the deep-link scheme is discovered from `app.json`, and a
debug build trusts the pin carried in the link itself. Everything under **Hardening** below
is for builds that leave your machine — do not do it as part of a first-time setup.

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
5. Optional: use `addCordieriteListener("error", ...)` to observe bootstrap parse
   failures, connect failures, or socket errors — one unified channel for all of them.
6. Advanced: use `getCordieriteState()` / `addCordieriteListener("stateChange", ...)` for
   manual connection-state UI.
7. Production builds that shouldn't ship Cordierite at all should import
   `@cordierite/react-native/noop` instead (see the package README's compile-out
   recipe) rather than relying on a runtime flag.

## Expo

1. Add `@cordierite/react-native` to the app dependencies.
2. Add the Cordierite Expo config plugin to the Expo config. Every option is optional for
   a dev build: `cliPins` and `trust` are hardening (below) and `allowPrivateLanOnly`
   defaults to `true` (fail-closed). `deepLinkScheme` is only *validated* against
   `expo.scheme` (the plugin warns when it names a scheme the app does not declare) — it
   is not what the CLI reads, and leaving it out changes nothing.
3. Make sure `expo.scheme` is set — it is both what registers the app for deep links and
   what `cordierite link` discovers automatically from `app.json`.
4. Run `cordierite init` in the app root. It records the scheme in
   `.cordierite/config.json` and prints the MCP server entry to paste into an agent's
   config. Re-running it is always safe: it keeps the scheme already recorded, and only
   notes it if `app.json` has since come to declare a different one. Use
   `cordierite init --force` to adopt the new `app.json` value.
5. Run prebuild or rebuild the native project so the native config is applied.
6. Use a development build. Expo Go is not enough — this library ships native code.

If the project uses a dynamic `app.config.js` / `app.config.ts`, discovery does not apply
(Cordierite never executes project code to read a scheme). Use
`cordierite init --scheme <scheme>` once, or pass `--scheme` / set `CORDIERITE_SCHEME`.

## Bare React Native

1. Add `@cordierite/react-native` to the app dependencies.
2. Run the normal native dependency installation steps for the project.
3. Configure URL schemes / intent filters so bootstrap links (`{scheme}:///?cordierite=…`)
   open your app.
4. Run `cordierite init --scheme <scheme>` in the project root — there is no `app.json`
   `expo.scheme` to discover, so name the scheme you configured in step 3.
5. Add the optional private-LAN-only setting only if the project wants that restriction.
6. Rebuild the native app after the configuration changes.

## Hardening (not needed for a dev loop)

For builds that leave your machine, replace link-carried trust with embedded pins:

1. Run `cordierite keygen` (non-interactive with `--out <path>`; writes
   `~/.cordierite/key.pem` by default, which is also where the daemon auto-generates one).
2. Add the printed `sha256/...` SPKI pin to the app configuration in a `cliPins` array
   (plural — the native clients accept a pin *set*, which is what makes future rotation
   non-breaking). Providing `cliPins` switches `trust` to `"pin"` by default.
3. Rebuild: this is native configuration, so it is not a fast in-session action.

## Final check

- The app has at least one registered tool.
- The app's deep-link scheme matches what `cordierite link` resolves — run
  `cordierite link --json` in the app root and read the scheme off the deep link; the
  error names every location it looked in if it cannot find one.
- `cordierite ls` (or `cordierite_connect` + `cordierite_wait_for_session` over MCP)
  reaches `state: "active"` once the app opens the link.
- Hardened builds only: the daemon's key is present and `0600`, and the app trusts its
  current pin in `cliPins`.
