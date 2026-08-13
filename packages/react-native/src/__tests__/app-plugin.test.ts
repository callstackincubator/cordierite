import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

// `app.plugin.js` is a CommonJS Expo config plugin at the package root, not a TS module under
// `src/` -- `createRequire` gives a clean, ESM-friendly way to load it without adding a `require`
// ambient declaration to this test file.
const require = createRequire(import.meta.url);

type NormalizedOptions = {
  include: boolean;
  trust: "link" | "pin";
  cliPins: string[];
  allowPrivateLanOnly: boolean;
  deepLinkScheme: string | undefined;
};

const cordieritePlugin = require("../../app.plugin.js") as {
  __internal: {
    SPKI_PIN_PATTERN: RegExp;
    validatePins: (cliPins: unknown) => string[];
    configuredSchemes: (expoConfig: unknown) => string[];
    normalizeOptions: (
      rawOptions: unknown,
      expoConfig: unknown,
    ) => {
      options: NormalizedOptions;
      warnings: string[];
    };
    applyInfoPlistChanges: (
      infoPlist: Record<string, unknown>,
      options: NormalizedOptions,
    ) => Record<string, unknown>;
    applyAndroidManifestChanges: (
      androidManifest: unknown,
      options: NormalizedOptions,
    ) => unknown;
    resolvePackageJsonAutolinkingExclude: (
      packageJson: unknown,
      platform: "ios" | "android",
    ) => string[];
    isExcludedByReactNativeConfig: (
      reactNativeConfig: unknown,
      platform: "ios" | "android",
    ) => boolean;
    assertIncludeMatchesAutolinking: (args: {
      include: boolean;
      platform: "ios" | "android";
      packageJson: unknown;
      reactNativeConfig: unknown;
    }) => void;
  };
};

const {
  validatePins,
  configuredSchemes,
  normalizeOptions,
  applyInfoPlistChanges,
  applyAndroidManifestChanges,
  resolvePackageJsonAutolinkingExclude,
  isExcludedByReactNativeConfig,
  assertIncludeMatchesAutolinking,
} = cordieritePlugin.__internal;

const PACKAGE_NAME = "@cordierite/react-native";

// A real SHA-256 digest, base64-encoded: 32 bytes -> 44 base64 characters (one `=` pad).
const VALID_PIN = "sha256/Jd5ES7Yt70PB1fYYVg5K3sLCpzPE1eEWxvrJ+i/H5rY=";

const minimalAndroidManifest = () => ({
  manifest: {
    application: [{ $: { "android:name": "com.example.app.MainApplication" } }],
  },
});

describe("app.plugin.js: validatePins", () => {
  test("an omitted cliPins normalizes to []", () => {
    expect(validatePins(undefined)).toEqual([]);
  });

  test("an explicit empty array is accepted", () => {
    expect(validatePins([])).toEqual([]);
  });

  test("throws naming the offending value when a pin does not match sha256/<44-char base64>", () => {
    expect(() => validatePins(["not-a-pin"])).toThrow(/"not-a-pin"/);
  });

  test("throws on a pin that is the right shape but wrong length", () => {
    expect(() => validatePins(["sha256/tooShort="])).toThrow(
      /is not a valid SPKI pin/,
    );
  });

  test("accepts a well-formed pin", () => {
    expect(validatePins([VALID_PIN])).toEqual([VALID_PIN]);
  });

  test("throws when cliPins is not an array", () => {
    expect(() => validatePins("not-an-array")).toThrow(
      /requires "cliPins" to be an array/,
    );
  });
});

describe("app.plugin.js: normalizeOptions", () => {
  test("enableInReleaseBuilds throws, naming include/trust", () => {
    expect(() => normalizeOptions({ enableInReleaseBuilds: true }, {})).toThrow(
      /"enableInReleaseBuilds" has been removed/,
    );
    expect(() => normalizeOptions({ enableInReleaseBuilds: true }, {})).toThrow(
      /"include"/,
    );
    expect(() => normalizeOptions({ enableInReleaseBuilds: true }, {})).toThrow(
      /"trust"/,
    );
  });

  test("enableInReleaseBuilds: false still throws (the option itself is gone, not just true)", () => {
    expect(() =>
      normalizeOptions({ enableInReleaseBuilds: false }, {}),
    ).toThrow(/"enableInReleaseBuilds" has been removed/);
  });

  test("include defaults to true", () => {
    const { options } = normalizeOptions({}, {});
    expect(options.include).toBe(true);
  });

  test("include: false is honored", () => {
    const { options } = normalizeOptions({ include: false }, {});
    expect(options.include).toBe(false);
  });

  test("include must be a boolean", () => {
    expect(() => normalizeOptions({ include: "yes" }, {})).toThrow(
      /"include" must be a boolean/,
    );
  });

  test("trust defaults to link when cliPins is absent", () => {
    const { options } = normalizeOptions({}, {});
    expect(options.trust).toBe("link");
  });

  test("trust defaults to pin when cliPins is present (non-empty)", () => {
    const { options } = normalizeOptions({ cliPins: [VALID_PIN] }, {});
    expect(options.trust).toBe("pin");
  });

  test("trust defaults to pin when cliPins is present but explicitly empty", () => {
    // cliPins: [] with no explicit trust still counts as "provided" for the default, which is
    // exactly the combination that then trips the trust:pin-requires-non-empty-cliPins error.
    expect(() => normalizeOptions({ cliPins: [] }, {})).toThrow(
      /requires a non-empty "cliPins" array/,
    );
  });

  test("an unrecognized trust value is a hard error, not a fallback to the default", () => {
    expect(() =>
      normalizeOptions({ trust: "PIN", cliPins: [VALID_PIN] }, {}),
    ).toThrow(/"trust" must be "link" or "pin", got "PIN"/);
    expect(() => normalizeOptions({ trust: "pinn" }, {})).toThrow(
      /"trust" must be "link" or "pin", got "pinn"/,
    );
  });

  test("trust: pin with cliPins missing throws", () => {
    expect(() => normalizeOptions({ trust: "pin" }, {})).toThrow(
      /requires a non-empty "cliPins" array/,
    );
  });

  test("trust: pin with cliPins explicitly empty throws", () => {
    expect(() => normalizeOptions({ trust: "pin", cliPins: [] }, {})).toThrow(
      /requires a non-empty "cliPins" array/,
    );
  });

  test("trust: pin with non-empty cliPins succeeds", () => {
    const { options } = normalizeOptions(
      { trust: "pin", cliPins: [VALID_PIN] },
      {},
    );
    expect(options.trust).toBe("pin");
    expect(options.cliPins).toEqual([VALID_PIN]);
  });

  test("trust: link with no cliPins succeeds", () => {
    const { options, warnings } = normalizeOptions({ trust: "link" }, {});
    expect(options.trust).toBe("link");
    expect(options.cliPins).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("trust: link with cliPins present warns that embedded pins win regardless", () => {
    const { warnings } = normalizeOptions(
      { trust: "link", cliPins: [VALID_PIN] },
      {},
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("cliPins");
    expect(warnings[0]).toContain("trust");
  });

  test("trust: pin with cliPins present does not warn", () => {
    const { warnings } = normalizeOptions(
      { trust: "pin", cliPins: [VALID_PIN] },
      {},
    );
    expect(warnings).toEqual([]);
  });

  test("defaults allowPrivateLanOnly to true (fail-closed) when omitted", () => {
    const { options } = normalizeOptions({ cliPins: [VALID_PIN] }, {});
    expect(options.allowPrivateLanOnly).toBe(true);
  });

  test("honors an explicit allowPrivateLanOnly: false", () => {
    const { options } = normalizeOptions(
      { cliPins: [VALID_PIN], allowPrivateLanOnly: false },
      {},
    );
    expect(options.allowPrivateLanOnly).toBe(false);
  });

  test("warns when deepLinkScheme is not declared in the Expo config's scheme field", () => {
    const { warnings } = normalizeOptions(
      { trust: "pin", cliPins: [VALID_PIN], deepLinkScheme: "myapp" },
      { scheme: "otherapp" },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("myapp");
  });

  test("does not warn when deepLinkScheme matches a string scheme", () => {
    const { warnings } = normalizeOptions(
      { trust: "pin", cliPins: [VALID_PIN], deepLinkScheme: "myapp" },
      { scheme: "myapp" },
    );
    expect(warnings).toEqual([]);
  });

  test("does not warn when deepLinkScheme matches one entry of an array scheme", () => {
    const { warnings } = normalizeOptions(
      { trust: "pin", cliPins: [VALID_PIN], deepLinkScheme: "myapp" },
      { scheme: ["otherapp", "myapp"] },
    );
    expect(warnings).toEqual([]);
  });

  test("does not warn when deepLinkScheme is omitted", () => {
    const { warnings } = normalizeOptions(
      { trust: "pin", cliPins: [VALID_PIN] },
      {},
    );
    expect(warnings).toEqual([]);
  });

  test("propagates validatePins' throw for an invalid pin", () => {
    expect(() => normalizeOptions({ cliPins: ["bad"] }, {})).toThrow(
      /is not a valid SPKI pin/,
    );
  });
});

describe("app.plugin.js: configuredSchemes", () => {
  test("wraps a single string scheme", () => {
    expect(configuredSchemes({ scheme: "myapp" })).toEqual(["myapp"]);
  });

  test("passes through an array scheme", () => {
    expect(configuredSchemes({ scheme: ["a", "b"] })).toEqual(["a", "b"]);
  });

  test("is empty when scheme is missing", () => {
    expect(configuredSchemes({})).toEqual([]);
  });
});

describe("app.plugin.js: applyInfoPlistChanges", () => {
  test("writes pins, trust, and a real boolean allowPrivateLanOnly", () => {
    const infoPlist = applyInfoPlistChanges(
      {},
      {
        include: true,
        trust: "pin",
        cliPins: [VALID_PIN],
        allowPrivateLanOnly: true,
        deepLinkScheme: undefined,
      },
    );
    expect(infoPlist["CordieriteCliPins"]).toEqual([VALID_PIN]);
    expect(infoPlist["CordieriteAllowPrivateLanOnly"]).toBe(true);
    expect(typeof infoPlist["CordieriteAllowPrivateLanOnly"]).toBe("boolean");
    expect(infoPlist["CordieriteTrust"]).toBe("pin");
  });

  test("writes trust: link and an empty pins array when cliPins is omitted", () => {
    const infoPlist = applyInfoPlistChanges(
      {},
      {
        include: true,
        trust: "link",
        cliPins: [],
        allowPrivateLanOnly: true,
        deepLinkScheme: undefined,
      },
    );
    expect(infoPlist["CordieriteCliPins"]).toEqual([]);
    expect(infoPlist["CordieriteTrust"]).toBe("link");
  });
});

describe("app.plugin.js: applyAndroidManifestChanges", () => {
  const metaDataOf = (manifest: unknown) =>
    (
      manifest as {
        manifest: {
          application: [{ "meta-data": { $: Record<string, unknown> }[] }];
        };
      }
    ).manifest.application[0]["meta-data"];

  test("writes the pins JSON string, trust, and a real boolean allowPrivateLanOnly meta-data value", () => {
    const manifest = applyAndroidManifestChanges(minimalAndroidManifest(), {
      include: true,
      trust: "pin",
      cliPins: [VALID_PIN],
      allowPrivateLanOnly: true,
      deepLinkScheme: undefined,
    });

    const metaData = metaDataOf(manifest);
    const pins = metaData.find(
      (item) =>
        item.$["android:name"] === "com.callstackincubator.cordierite.CLI_PINS",
    );
    const privateLan = metaData.find(
      (item) =>
        item.$["android:name"] ===
        "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY",
    );
    const trust = metaData.find(
      (item) =>
        item.$["android:name"] === "com.callstackincubator.cordierite.TRUST",
    );

    expect(pins?.$["android:value"]).toBe(JSON.stringify([VALID_PIN]));
    // A real boolean survives in the in-memory manifest model ("write it in a form native
    // actually reads"), not a stringified `"true"`.
    expect(privateLan?.$["android:value"]).toBe(true);
    expect(typeof privateLan?.$["android:value"]).toBe("boolean");
    expect(trust?.$["android:value"]).toBe("pin");
  });

  test("writes an empty CLI_PINS meta-data value when cliPins is []", () => {
    const manifest = applyAndroidManifestChanges(minimalAndroidManifest(), {
      include: true,
      trust: "link",
      cliPins: [],
      allowPrivateLanOnly: true,
      deepLinkScheme: undefined,
    });

    const pins = metaDataOf(manifest).find(
      (item) =>
        item.$["android:name"] === "com.callstackincubator.cordierite.CLI_PINS",
    );
    expect(pins?.$["android:value"]).toBe(JSON.stringify([]));
  });

  test("never writes an ENABLE_IN_RELEASE meta-data key", () => {
    const manifest = applyAndroidManifestChanges(minimalAndroidManifest(), {
      include: true,
      trust: "pin",
      cliPins: [VALID_PIN],
      allowPrivateLanOnly: true,
      deepLinkScheme: undefined,
    });

    const enableInRelease = metaDataOf(manifest).find((item) =>
      String(item.$["android:name"]).includes("ENABLE_IN_RELEASE"),
    );
    expect(enableInRelease).toBeUndefined();
  });

  test("throws when the manifest has no MainApplication element", () => {
    expect(() =>
      applyAndroidManifestChanges(
        { manifest: { application: [] } },
        {
          include: true,
          trust: "pin",
          cliPins: [VALID_PIN],
          allowPrivateLanOnly: true,
          deepLinkScheme: undefined,
        },
      ),
    ).toThrow();
  });
});

describe("app.plugin.js: resolvePackageJsonAutolinkingExclude", () => {
  test("returns [] when expo.autolinking is absent", () => {
    expect(resolvePackageJsonAutolinkingExclude({}, "ios")).toEqual([]);
  });

  test("reads the root exclude list when no platform override exists", () => {
    const packageJson = {
      expo: { autolinking: { exclude: [PACKAGE_NAME] } },
    };
    expect(resolvePackageJsonAutolinkingExclude(packageJson, "ios")).toEqual([
      PACKAGE_NAME,
    ]);
    expect(
      resolvePackageJsonAutolinkingExclude(packageJson, "android"),
    ).toEqual([PACKAGE_NAME]);
  });

  test("a platform-specific exclude fully replaces the root exclude (no concatenation)", () => {
    const packageJson = {
      expo: {
        autolinking: {
          exclude: ["some-other-package"],
          ios: { exclude: [PACKAGE_NAME] },
        },
      },
    };
    expect(resolvePackageJsonAutolinkingExclude(packageJson, "ios")).toEqual([
      PACKAGE_NAME,
    ]);
    // android has no override, so it still sees the root list.
    expect(
      resolvePackageJsonAutolinkingExclude(packageJson, "android"),
    ).toEqual(["some-other-package"]);
  });

  test("an explicit empty platform override clears the root exclude for that platform", () => {
    const packageJson = {
      expo: {
        autolinking: {
          exclude: [PACKAGE_NAME],
          android: { exclude: [] },
        },
      },
    };
    expect(
      resolvePackageJsonAutolinkingExclude(packageJson, "android"),
    ).toEqual([]);
  });

  // `app.json`/`app.config.*` are never consulted here -- verified as the real behavior in task
  // 02. This function only ever receives a parsed `package.json`, so there is nothing further to
  // assert beyond "this function has no app.json/app.config parameter at all".
});

describe("app.plugin.js: isExcludedByReactNativeConfig", () => {
  test("false when reactNativeConfig is null", () => {
    expect(isExcludedByReactNativeConfig(null, "ios")).toBe(false);
  });

  test("false when the package has no dependency entry", () => {
    expect(isExcludedByReactNativeConfig({ dependencies: {} }, "ios")).toBe(
      false,
    );
  });

  test("true when the platform is explicitly null", () => {
    const rnConfig = {
      dependencies: { [PACKAGE_NAME]: { platforms: { ios: null } } },
    };
    expect(isExcludedByReactNativeConfig(rnConfig, "ios")).toBe(true);
    expect(isExcludedByReactNativeConfig(rnConfig, "android")).toBe(false);
  });
});

describe("app.plugin.js: assertIncludeMatchesAutolinking", () => {
  test("include: true and not excluded anywhere passes silently", () => {
    expect(() =>
      assertIncludeMatchesAutolinking({
        include: true,
        platform: "ios",
        packageJson: {},
        reactNativeConfig: null,
      }),
    ).not.toThrow();
  });

  test("include: true but excluded via package.json throws, naming the file", () => {
    expect(() =>
      assertIncludeMatchesAutolinking({
        include: true,
        platform: "ios",
        packageJson: { expo: { autolinking: { exclude: [PACKAGE_NAME] } } },
        reactNativeConfig: null,
      }),
    ).toThrow(/package\.json/);
  });

  test("include: true but excluded via react-native.config.js throws, naming that file", () => {
    expect(() =>
      assertIncludeMatchesAutolinking({
        include: true,
        platform: "android",
        packageJson: {},
        reactNativeConfig: {
          dependencies: { [PACKAGE_NAME]: { platforms: { android: null } } },
        },
      }),
    ).toThrow(/react-native\.config\.js/);
  });

  test("include: true but excluded only on the other platform passes for this platform", () => {
    expect(() =>
      assertIncludeMatchesAutolinking({
        include: true,
        platform: "android",
        packageJson: {
          expo: { autolinking: { ios: { exclude: [PACKAGE_NAME] } } },
        },
        reactNativeConfig: null,
      }),
    ).not.toThrow();
  });

  test("include: true but excluded on both platforms reports the platform passed in, not just 'mismatch'", () => {
    const packageJson = {
      expo: {
        autolinking: {
          ios: { exclude: [PACKAGE_NAME] },
          android: { exclude: [PACKAGE_NAME] },
        },
      },
    };
    expect(() =>
      assertIncludeMatchesAutolinking({
        include: true,
        platform: "ios",
        packageJson,
        reactNativeConfig: null,
      }),
    ).toThrow(/ios/);
    expect(() =>
      assertIncludeMatchesAutolinking({
        include: true,
        platform: "android",
        packageJson,
        reactNativeConfig: null,
      }),
    ).toThrow(/android/);
  });

  test("include: false and excluded passes silently", () => {
    expect(() =>
      assertIncludeMatchesAutolinking({
        include: false,
        platform: "ios",
        packageJson: { expo: { autolinking: { exclude: [PACKAGE_NAME] } } },
        reactNativeConfig: null,
      }),
    ).not.toThrow();
  });

  test("include: false but not excluded throws with a copy-pasteable package.json snippet", () => {
    expect(() =>
      assertIncludeMatchesAutolinking({
        include: false,
        platform: "ios",
        packageJson: {},
        reactNativeConfig: null,
      }),
    ).toThrow(/"exclude": \["@cordierite\/react-native"\]/);
  });
});

describe("app.plugin.js: drift guard against the real expo-modules-autolinking resolver", () => {
  // This is the "prefer reading the same config the resolver reads over reimplementing the
  // merge" acceptance criterion from docs/tasks/06-config-plugin-rewrite.md: it runs the actual
  // `expo-modules-autolinking` package (a transitive dependency via the `expo` devDependency)
  // against a fixture project and asserts `resolvePackageJsonAutolinkingExclude`'s output matches
  // it exactly, so an upstream merge-behavior change breaks this test instead of silently
  // drifting from reality.
  const loadRealResolver = () => {
    const expoPackageJsonPath = require.resolve("expo/package.json", {
      paths: [path.resolve(__dirname, "..", "..")],
    });
    const autolinkingExportsPath = require.resolve(
      "expo-modules-autolinking/build/exports.js",
      { paths: [path.dirname(expoPackageJsonPath)] },
    );
    return (
      require(autolinkingExportsPath) as {
        mergeLinkingOptionsAsync: (options: {
          projectRoot: string;
          platform: "ios" | "android";
        }) => Promise<{ exclude?: string[] }>;
      }
    ).mergeLinkingOptionsAsync;
  };

  const withFixtureProject = async <T>(
    packageJson: Record<string, unknown>,
    run: (projectRoot: string) => Promise<T>,
  ): Promise<T> => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cordierite-autolinking-fixture-"),
    );
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify(packageJson, null, 2),
      );
      // Awaited before cleanup below runs -- otherwise the fixture directory would be removed
      // out from under the real resolver's async file read.
      return await run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const fixtures: {
    name: string;
    packageJson: Record<string, unknown>;
  }[] = [
    {
      name: "no expo.autolinking at all",
      packageJson: { name: "fixture-app" },
    },
    {
      name: "root exclude only",
      packageJson: {
        name: "fixture-app",
        expo: { autolinking: { exclude: [PACKAGE_NAME] } },
      },
    },
    {
      name: "platform-specific exclude overrides root",
      packageJson: {
        name: "fixture-app",
        expo: {
          autolinking: {
            exclude: ["some-other-package"],
            ios: { exclude: [PACKAGE_NAME] },
          },
        },
      },
    },
    {
      name: "explicit empty platform override clears the root exclude",
      packageJson: {
        name: "fixture-app",
        expo: {
          autolinking: {
            exclude: [PACKAGE_NAME],
            android: { exclude: [] },
          },
        },
      },
    },
  ];

  for (const fixture of fixtures) {
    test(`matches the real resolver: ${fixture.name}`, async () => {
      const mergeLinkingOptionsAsync = loadRealResolver();

      await withFixtureProject(fixture.packageJson, async (projectRoot) => {
        for (const platform of ["ios", "android"] as const) {
          const real = await mergeLinkingOptionsAsync({
            projectRoot,
            platform,
          });
          const ours = resolvePackageJsonAutolinkingExclude(
            fixture.packageJson,
            platform,
          );
          expect(ours).toEqual(real.exclude ?? []);
        }
      });
    });
  }
});
