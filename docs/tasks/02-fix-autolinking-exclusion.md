# 02 — Fix the autolinking exclusion recipe

**Wave 1. Depends on 01. Independent of every other task — it is a standalone bug fix and
can ship before the rest of this series.**

## Goal

The documented way to exclude Cordierite from a build actually excludes it, and the
playground demonstrates it working.

## Why — verified bug

`expo-modules-autolinking` reads `expo.autolinking` from **`package.json`**, never from
`app.json`. Confirmed in `parsePackageJsonOptions`
(`expo-modules-autolinking/build/commands/autolinkingOptions.js`) in both 3.0.26 (SDK 54) and
55.0.9, and in Expo's own docs.

The playground puts `autolinking.ios.exclude` in `app.json`, so it is a silent no-op:

```
$ cd playground && node --no-warnings --eval "require('expo/bin/autolinking')" \
    expo-modules-autolinking react-native-config --json --platform ios
deps: ['expo', '@cordierite/react-native', 'react-native-gesture-handler', ...]
```

Passing the same name via `--exclude` drops it, so the mechanism works — it just never
receives the app.json value.

Consequences today:

- `packages/react-native/README.md`'s Expo recipe and `docs/SECURITY.md`'s "Expo-managed
  equivalent" are both wrong, and they are the recipe this whole design now rests on.
- The playground links the Cordierite pod twice — once via autolinking, once via
  `playground/plugins/with-native-tests.js`' explicit `pod` line — and that plugin's comment
  ("Expo Autolinking … intentionally links just the production pod") describes an exclusion
  that never happened.

## Scope

- `packages/react-native/README.md`: move the Expo exclude snippet to `package.json`, keep
  the bare-RN `react-native.config.js` snippet as-is (that one is correct).
- `docs/SECURITY.md`: same fix in "Compile out of release builds you don't want carrying
  Cordierite at all".
- `playground/app.json`: remove the ineffective `expo.autolinking` block.
- `playground/package.json`: add the real one. Decide and document what the playground
  should demonstrate — it needs the pod present for the XCTest target, so the honest
  configuration is probably iOS included + Android excluded, or a comment explaining why
  neither is excluded there.
- `playground/plugins/with-native-tests.js`: correct the comment about what autolinking
  does, once the config reflects reality.

## Acceptance

- With the exclude in place, the resolver command above omits `@cordierite/react-native` for
  the excluded platform(s).
- `playground/ios/Podfile.lock` contains exactly one `Cordierite` entry after a clean
  `expo prebuild --clean` + `pod install`.
- A note in the README states plainly that this is read from `package.json`, because the
  wrong location fails silently and this bug has already shipped once.
