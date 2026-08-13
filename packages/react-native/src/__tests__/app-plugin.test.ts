import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

// `app.plugin.js` is a CommonJS Expo config plugin at the package root, not a TS module under
// `src/` -- `createRequire` gives a clean, ESM-friendly way to load it without adding a `require`
// ambient declaration to this test file.
const require = createRequire(import.meta.url);

const cordieritePlugin = require("../../app.plugin.js") as {
  __internal: {
    SPKI_PIN_PATTERN: RegExp;
    validatePins: (
      cliPins: unknown,
      options?: { requireNonEmpty?: boolean },
    ) => string[];
    configuredSchemes: (expoConfig: unknown) => string[];
    normalizeOptions: (
      rawOptions: unknown,
      expoConfig: unknown,
    ) => {
      options: {
        cliPins: string[] | undefined;
        allowPrivateLanOnly: boolean;
        deepLinkScheme: string | undefined;
        enableInReleaseBuilds: boolean;
      };
      warnings: string[];
    };
    applyInfoPlistChanges: (
      infoPlist: Record<string, unknown>,
      options: { cliPins: string[] | undefined; allowPrivateLanOnly: boolean },
    ) => Record<string, unknown>;
    applyAndroidManifestChanges: (
      androidManifest: unknown,
      options: {
        cliPins: string[] | undefined;
        allowPrivateLanOnly: boolean;
        enableInReleaseBuilds?: boolean;
      },
    ) => unknown;
    ENABLE_IN_RELEASE_PODFILE_MARKER: string;
    addEnableInReleaseFlagToPodfile: (podfile: string) => string;
  };
};

const {
  validatePins,
  configuredSchemes,
  normalizeOptions,
  applyInfoPlistChanges,
  applyAndroidManifestChanges,
  ENABLE_IN_RELEASE_PODFILE_MARKER,
  addEnableInReleaseFlagToPodfile,
} = cordieritePlugin.__internal;

// A real SHA-256 digest, base64-encoded: 32 bytes -> 44 base64 characters (one `=` pad).
const VALID_PIN = "sha256/Jd5ES7Yt70PB1fYYVg5K3sLCpzPE1eEWxvrJ+i/H5rY=";

const minimalAndroidManifest = () => ({
  manifest: {
    application: [{ $: { "android:name": "com.example.app.MainApplication" } }],
  },
});

describe("app.plugin.js: validatePins", () => {
  test("throws when cliPins is missing", () => {
    expect(() => validatePins(undefined)).toThrow(/non-empty cliPins array/);
  });

  test("throws when cliPins is empty", () => {
    expect(() => validatePins([])).toThrow(/non-empty cliPins array/);
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

  // cliPins becomes optional when not opting into release.
  test("with requireNonEmpty: false, an omitted cliPins normalizes to [] instead of throwing", () => {
    expect(validatePins(undefined, { requireNonEmpty: false })).toEqual([]);
  });

  test("with requireNonEmpty: false, an explicit empty array is still accepted", () => {
    expect(validatePins([], { requireNonEmpty: false })).toEqual([]);
  });

  test("with requireNonEmpty: false, a malformed pin still throws (format is always checked)", () => {
    expect(() =>
      validatePins(["not-a-pin"], { requireNonEmpty: false }),
    ).toThrow(/"not-a-pin"/);
  });

  test("with requireNonEmpty: false, a well-formed pin is still accepted", () => {
    expect(validatePins([VALID_PIN], { requireNonEmpty: false })).toEqual([
      VALID_PIN,
    ]);
  });
});

describe("app.plugin.js: normalizeOptions", () => {
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

  // `enableInReleaseBuilds: true` below keeps these scoped to the deepLinkScheme warning only --
  // without it, the cliPins-without-enableInReleaseBuilds warning (tested separately below) would
  // also fire and inflate the warnings array these assertions check.
  test("warns when deepLinkScheme is not declared in the Expo config's scheme field", () => {
    const { warnings } = normalizeOptions(
      {
        cliPins: [VALID_PIN],
        enableInReleaseBuilds: true,
        deepLinkScheme: "myapp",
      },
      { scheme: "otherapp" },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("myapp");
  });

  test("does not warn when deepLinkScheme matches a string scheme", () => {
    const { warnings } = normalizeOptions(
      {
        cliPins: [VALID_PIN],
        enableInReleaseBuilds: true,
        deepLinkScheme: "myapp",
      },
      { scheme: "myapp" },
    );
    expect(warnings).toEqual([]);
  });

  test("does not warn when deepLinkScheme matches one entry of an array scheme", () => {
    const { warnings } = normalizeOptions(
      {
        cliPins: [VALID_PIN],
        enableInReleaseBuilds: true,
        deepLinkScheme: "myapp",
      },
      { scheme: ["otherapp", "myapp"] },
    );
    expect(warnings).toEqual([]);
  });

  test("does not warn when deepLinkScheme is omitted", () => {
    const { warnings } = normalizeOptions(
      { cliPins: [VALID_PIN], enableInReleaseBuilds: true },
      {},
    );
    expect(warnings).toEqual([]);
  });

  test("propagates validatePins' throw for an invalid pin", () => {
    expect(() => normalizeOptions({ cliPins: ["bad"] }, {})).toThrow(
      /is not a valid SPKI pin/,
    );
  });

  // cliPins becomes optional when not opting into release.
  // Test matrix below: enableInReleaseBuilds true/false/absent x cliPins valid/empty/invalid/absent.

  test("cliPins is optional when enableInReleaseBuilds is absent: normalizes to undefined, not []", () => {
    const { options } = normalizeOptions({}, {});
    // undefined (not []) so applyInfoPlistChanges/applyAndroidManifestChanges can tell "omitted"
    // apart from "explicitly empty" and skip writing the pins key entirely.
    expect(options.cliPins).toBeUndefined();
    expect(options.enableInReleaseBuilds).toBe(false);
  });

  test("enableInReleaseBuilds: false + cliPins absent succeeds, cliPins stays undefined", () => {
    const { options, warnings } = normalizeOptions(
      { enableInReleaseBuilds: false },
      {},
    );
    expect(options.cliPins).toBeUndefined();
    expect(options.enableInReleaseBuilds).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("enableInReleaseBuilds: absent + cliPins valid succeeds and is preserved", () => {
    const { options } = normalizeOptions({ cliPins: [VALID_PIN] }, {});
    expect(options.cliPins).toEqual([VALID_PIN]);
    expect(options.enableInReleaseBuilds).toBe(false);
  });

  test("enableInReleaseBuilds: false + cliPins valid succeeds and is preserved", () => {
    const { options } = normalizeOptions(
      { enableInReleaseBuilds: false, cliPins: [VALID_PIN] },
      {},
    );
    expect(options.cliPins).toEqual([VALID_PIN]);
  });

  test("enableInReleaseBuilds: absent + cliPins empty array succeeds (still optional)", () => {
    const { options } = normalizeOptions({ cliPins: [] }, {});
    expect(options.cliPins).toEqual([]);
  });

  test("enableInReleaseBuilds: false + cliPins invalid still throws (format always checked)", () => {
    expect(() =>
      normalizeOptions({ enableInReleaseBuilds: false, cliPins: ["bad"] }, {}),
    ).toThrow(/is not a valid SPKI pin/);
  });

  test("enableInReleaseBuilds: absent + cliPins invalid still throws", () => {
    expect(() => normalizeOptions({ cliPins: ["bad"] }, {})).toThrow(
      /is not a valid SPKI pin/,
    );
  });

  test("enableInReleaseBuilds: true requires a non-empty cliPins (absent and empty both throw)", () => {
    expect(() => normalizeOptions({ enableInReleaseBuilds: true }, {})).toThrow(
      /non-empty cliPins array/,
    );
    expect(() =>
      normalizeOptions({ enableInReleaseBuilds: true, cliPins: [] }, {}),
    ).toThrow(/non-empty cliPins array/);
  });

  test("enableInReleaseBuilds: true + cliPins invalid throws the SPKI-shape error, not the non-empty one", () => {
    expect(() =>
      normalizeOptions({ enableInReleaseBuilds: true, cliPins: ["bad"] }, {}),
    ).toThrow(/is not a valid SPKI pin/);
  });

  test("enableInReleaseBuilds: true with a valid cliPins succeeds", () => {
    const { options } = normalizeOptions(
      { enableInReleaseBuilds: true, cliPins: [VALID_PIN] },
      {},
    );
    expect(options.enableInReleaseBuilds).toBe(true);
    expect(options.cliPins).toEqual([VALID_PIN]);
  });

  // cliPins set without enableInReleaseBuilds is very likely
  // a misconfiguration -- the team almost certainly expects production trust to work.
  describe("enableInReleaseBuilds/cliPins mismatch warning", () => {
    test("warns when cliPins is set but enableInReleaseBuilds is absent", () => {
      const { warnings } = normalizeOptions({ cliPins: [VALID_PIN] }, {});
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("cliPins");
      expect(warnings[0]).toContain("enableInReleaseBuilds");
    });

    test("warns when cliPins is set and enableInReleaseBuilds is explicitly false", () => {
      const { warnings } = normalizeOptions(
        { cliPins: [VALID_PIN], enableInReleaseBuilds: false },
        {},
      );
      expect(warnings).toHaveLength(1);
    });

    test("warns even when the set cliPins is an explicit empty array", () => {
      const { warnings } = normalizeOptions({ cliPins: [] }, {});
      expect(warnings).toHaveLength(1);
    });

    test("does not warn when both cliPins and enableInReleaseBuilds: true are set", () => {
      const { warnings } = normalizeOptions(
        { cliPins: [VALID_PIN], enableInReleaseBuilds: true },
        {},
      );
      expect(warnings).toEqual([]);
    });

    test("does not warn when neither cliPins nor enableInReleaseBuilds is set", () => {
      const { warnings } = normalizeOptions({}, {});
      expect(warnings).toEqual([]);
    });
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
  test("writes pins and a real boolean allowPrivateLanOnly", () => {
    const infoPlist = applyInfoPlistChanges(
      {},
      { cliPins: [VALID_PIN], allowPrivateLanOnly: true },
    );
    expect(infoPlist["CordieriteCliPins"]).toEqual([VALID_PIN]);
    expect(infoPlist["CordieriteAllowPrivateLanOnly"]).toBe(true);
    expect(typeof infoPlist["CordieriteAllowPrivateLanOnly"]).toBe("boolean");
  });

  // cliPins optional -- absent means no pins key at all.
  test("writes no CordieriteCliPins key at all when cliPins is undefined (absent)", () => {
    const infoPlist = applyInfoPlistChanges(
      {},
      { cliPins: undefined, allowPrivateLanOnly: true },
    );
    expect("CordieriteCliPins" in infoPlist).toBe(false);
    // allowPrivateLanOnly is unaffected by cliPins being absent.
    expect(infoPlist["CordieriteAllowPrivateLanOnly"]).toBe(true);
  });

  test("writes an explicit empty CordieriteCliPins array when cliPins is []", () => {
    const infoPlist = applyInfoPlistChanges(
      {},
      { cliPins: [], allowPrivateLanOnly: true },
    );
    expect(infoPlist["CordieriteCliPins"]).toEqual([]);
  });
});

describe("app.plugin.js: applyAndroidManifestChanges", () => {
  test("writes the pins JSON string and a real boolean allowPrivateLanOnly meta-data value", () => {
    const manifest = applyAndroidManifestChanges(minimalAndroidManifest(), {
      cliPins: [VALID_PIN],
      allowPrivateLanOnly: true,
    }) as {
      manifest: {
        application: [{ "meta-data": { $: Record<string, unknown> }[] }];
      };
    };

    const metaData = manifest.manifest.application[0]["meta-data"];
    const pins = metaData.find(
      (item) =>
        item.$["android:name"] === "com.callstackincubator.cordierite.CLI_PINS",
    );
    const privateLan = metaData.find(
      (item) =>
        item.$["android:name"] ===
        "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY",
    );

    expect(pins?.$["android:value"]).toBe(JSON.stringify([VALID_PIN]));
    // A real boolean survives in the in-memory manifest model ("write it in a form native
    // actually reads"), not a stringified `"true"` -- distinguishing this from the earlier bug.
    expect(privateLan?.$["android:value"]).toBe(true);
    expect(typeof privateLan?.$["android:value"]).toBe("boolean");
  });

  test("throws when the manifest has no MainApplication element", () => {
    expect(() =>
      applyAndroidManifestChanges(
        { manifest: { application: [] } },
        { cliPins: [VALID_PIN], allowPrivateLanOnly: true },
      ),
    ).toThrow();
  });

  // Default-inert release builds.
  test("writes a real boolean ENABLE_IN_RELEASE meta-data value, defaulting to false", () => {
    const manifest = applyAndroidManifestChanges(minimalAndroidManifest(), {
      cliPins: [VALID_PIN],
      allowPrivateLanOnly: true,
    }) as {
      manifest: {
        application: [{ "meta-data": { $: Record<string, unknown> }[] }];
      };
    };

    const metaData = manifest.manifest.application[0]["meta-data"];
    const enableInRelease = metaData.find(
      (item) =>
        item.$["android:name"] ===
        "com.callstackincubator.cordierite.ENABLE_IN_RELEASE",
    );

    expect(enableInRelease?.$["android:value"]).toBe(false);
    expect(typeof enableInRelease?.$["android:value"]).toBe("boolean");
  });

  test("writes ENABLE_IN_RELEASE: true when enableInReleaseBuilds is true", () => {
    const manifest = applyAndroidManifestChanges(minimalAndroidManifest(), {
      cliPins: [VALID_PIN],
      allowPrivateLanOnly: true,
      enableInReleaseBuilds: true,
    }) as {
      manifest: {
        application: [{ "meta-data": { $: Record<string, unknown> }[] }];
      };
    };

    const metaData = manifest.manifest.application[0]["meta-data"];
    const enableInRelease = metaData.find(
      (item) =>
        item.$["android:name"] ===
        "com.callstackincubator.cordierite.ENABLE_IN_RELEASE",
    );

    expect(enableInRelease?.$["android:value"]).toBe(true);
  });

  // cliPins optional -- absent means no pins meta-data at all.
  test("writes no CLI_PINS meta-data at all when cliPins is undefined (absent)", () => {
    const manifest = applyAndroidManifestChanges(minimalAndroidManifest(), {
      cliPins: undefined,
      allowPrivateLanOnly: true,
    }) as {
      manifest: {
        application: [{ "meta-data": { $: Record<string, unknown> }[] }];
      };
    };

    const metaData = manifest.manifest.application[0]["meta-data"];
    const pins = metaData.find(
      (item) =>
        item.$["android:name"] === "com.callstackincubator.cordierite.CLI_PINS",
    );

    expect(pins).toBeUndefined();
    // The other keys are still written even when cliPins is absent.
    const privateLan = metaData.find(
      (item) =>
        item.$["android:name"] ===
        "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY",
    );
    expect(privateLan?.$["android:value"]).toBe(true);
  });

  test("writes an explicit empty CLI_PINS meta-data value when cliPins is []", () => {
    const manifest = applyAndroidManifestChanges(minimalAndroidManifest(), {
      cliPins: [],
      allowPrivateLanOnly: true,
    }) as {
      manifest: {
        application: [{ "meta-data": { $: Record<string, unknown> }[] }];
      };
    };

    const metaData = manifest.manifest.application[0]["meta-data"];
    const pins = metaData.find(
      (item) =>
        item.$["android:name"] === "com.callstackincubator.cordierite.CLI_PINS",
    );

    expect(pins?.$["android:value"]).toBe(JSON.stringify([]));
  });
});

describe("app.plugin.js: addEnableInReleaseFlagToPodfile", () => {
  const podfileWithHook = [
    "target 'playground' do",
    "  use_expo_modules!",
    "  post_install do |installer|",
    "    react_native_post_install(installer, config[:reactNativePath])",
    "  end",
    "end",
    "",
  ].join("\n");

  test("injects a Cordierite-only build_settings patch into the existing post_install hook", () => {
    const result = addEnableInReleaseFlagToPodfile(podfileWithHook);

    expect(result).toContain(ENABLE_IN_RELEASE_PODFILE_MARKER);
    expect(result).toContain("target.name == 'Cordierite'");
    // Both languages need the flag: Swift via
    // SWIFT_ACTIVE_COMPILATION_CONDITIONS, the ObjC++ bridge via GCC_PREPROCESSOR_DEFINITIONS.
    expect(result).toContain("SWIFT_ACTIVE_COMPILATION_CONDITIONS");
    expect(result).toContain("GCC_PREPROCESSOR_DEFINITIONS");
    expect(result).toContain("CORDIERITE_ENABLE_RELEASE=1");
    expect(result).toContain("CORDIERITE_ENABLE_RELEASE");
    // The pre-existing react_native_post_install call must still be present and untouched --
    // this must compose with the existing hook, not replace it.
    expect(result).toContain(
      "react_native_post_install(installer, config[:reactNativePath])",
    );
  });

  // Android parity (finding from post-task-12 review): CordieritePackage.kt's ENABLE_IN_RELEASE
  // meta-data enables every non-debuggable build variant, custom build types included -- not just
  // one literally named "release". The injected Ruby must not scope the flag to a build
  // configuration literally named 'Release', or a custom iOS configuration (e.g. "Staging") would
  // stay inert under enableInReleaseBuilds: true while the equivalent Android build is active.
  test("is not scoped to a build configuration literally named 'Release' -- applies to every configuration", () => {
    const result = addEnableInReleaseFlagToPodfile(podfileWithHook);

    expect(result).not.toContain("build_config.name ==");
    expect(result).not.toContain("next unless build_config");
    expect(result).toContain(
      "target.build_configurations.each do |build_config|",
    );
  });

  test("does not duplicate the patch on repeated prebuilds", () => {
    const once = addEnableInReleaseFlagToPodfile(podfileWithHook);
    expect(addEnableInReleaseFlagToPodfile(once)).toBe(once);
  });

  test("fails clearly when the Podfile has no post_install hook", () => {
    expect(() =>
      addEnableInReleaseFlagToPodfile("target 'playground' do\nend\n"),
    ).toThrow(/no "post_install do \|installer\|" hook/);
  });
});
