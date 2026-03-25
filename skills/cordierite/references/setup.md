# Cordierite setup

Use this file when the task is to add Cordierite to a new React Native project.

## Shared requirements

1. Install `cordierite` where the operator or agent will run the CLI.
2. Install `@cordierite/react-native` in the app.
3. Register the app tools you want Cordierite to expose.
4. Configure deep linking so the OS can open your app with the Cordierite bootstrap URL. Importing `@cordierite/react-native` registers listeners (via React Native `Linking`) that parse bootstrap URLs and call `connect` automatically; you do not need a manual `Linking` handler for the default flow.
5. Generate or provide a TLS private key for the host. For a new setup, prefer running `cordierite keygen` in an interactive terminal.
6. Add the matching `sha256/...` SPKI pin to the app configuration. Use the fingerprint printed by `cordierite keygen`. The CLI generates the leaf certificate automatically from that key and the resolved host IP.
7. Optional: use `addCordieriteErrorListener` to observe bootstrap parse failures or failed auto-`connect` attempts.
8. Advanced: use the exported `cordieriteClient` for manual `connect`, extra event listeners, or tests.

## Expo

1. Add `@cordierite/react-native` to the app dependencies.
2. Add the Cordierite Expo config plugin to the Expo config.
3. Configure at least `cliPins`; optionally configure the private-LAN-only restriction if the project wants it.
4. Make sure the app scheme used by the project matches the scheme the CLI will pass to `cordierite host --scheme ...`.
5. Run prebuild or rebuild the native project so the native config is applied.
6. Use a development build. Expo Go is not enough.

## Bare React Native

1. Add `@cordierite/react-native` to the app dependencies.
2. Run the normal native dependency installation steps for the project.
3. Add the trusted host pins to native configuration on iOS and Android.
4. Add the optional private-LAN-only setting only if the project wants that restriction.
5. Configure URL schemes / intent filters so bootstrap links (`{scheme}:///?cordierite=…`) open your app.
6. Rebuild the native app after the configuration changes.

## Final check

- The CLI host has a readable private key
- The app trusts the host's current pin
- The app has at least one registered tool
- The app scheme matches the `host --scheme` value
