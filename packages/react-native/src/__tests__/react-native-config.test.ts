import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";

// `react-native.config.js` is a CommonJS helper at the package root, not a TS module under
// `src/` -- see `metro.test.ts` for the same pattern with `metro.js`. `createRequire` loads it
// without adding a `require` ambient declaration to this test file.
const require = createRequire(import.meta.url);

const rnConfig = require("../../react-native.config.js") as {
  __testables: {
    resolvePlatforms: () => unknown;
    devOnly: unknown;
    everyBuild: unknown;
    excluded: { android: null; ios: null };
  };
};

const { resolvePlatforms, devOnly, everyBuild, excluded } =
  rnConfig.__testables;

const ENV_VAR = "CORDIERITE_ENABLED";

describe("react-native.config.js resolvePlatforms", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test("unset env: dev-only -- debug build type / Debug configuration, no release", () => {
    delete process.env[ENV_VAR];
    expect(resolvePlatforms()).toStrictEqual(devOnly);
    expect(
      (devOnly as { android: { buildTypes: string[] } }).android.buildTypes,
    ).toStrictEqual(["debug"]);
    expect(
      (devOnly as { ios: { configurations: string[] } }).ios.configurations,
    ).toStrictEqual(["Debug"]);
  });

  test("empty env: same as unset -- dev-only", () => {
    process.env[ENV_VAR] = "";
    expect(resolvePlatforms()).toStrictEqual(devOnly);
  });

  test.each(["1", "true", "TRUE"])(
    "%s: every build -- debug and release / Debug and Release",
    (value) => {
      process.env[ENV_VAR] = value;
      expect(resolvePlatforms()).toStrictEqual(everyBuild);
      expect(
        (everyBuild as { android: { buildTypes: string[] } }).android
          .buildTypes,
      ).toStrictEqual(["debug", "release"]);
      expect(
        (everyBuild as { ios: { configurations: string[] } }).ios
          .configurations,
      ).toStrictEqual(["Debug", "Release"]);
    },
  );

  test.each(["0", "false", "FALSE"])(
    "%s: excluded from every build",
    (value) => {
      process.env[ENV_VAR] = value;
      expect(resolvePlatforms()).toStrictEqual(excluded);
    },
  );

  test("unparseable value: falls back to every build rather than throwing", () => {
    process.env[ENV_VAR] = "yes-please";
    expect(resolvePlatforms()).toStrictEqual(everyBuild);
  });
});
