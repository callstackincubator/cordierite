import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";

// `app.plugin.js` is a CommonJS Expo config plugin at the package root, not a TS module under
// `src/` -- `createRequire` gives a clean, ESM-friendly way to load it without adding a `require`
// ambient declaration to this test file.
const require = createRequire(import.meta.url);

const cordieritePlugin = require("../../app.plugin.js") as {
  __internal: {
    SPKI_PIN_PATTERN: RegExp;
    validatePins: (cliPins: unknown) => string[];
    configuredSchemes: (expoConfig: unknown) => string[];
    normalizeOptions: (
      rawOptions: unknown,
      expoConfig: unknown
    ) => {
      options: {
        cliPins: string[];
        allowPrivateLanOnly: boolean;
        deepLinkScheme: string | undefined;
      };
      warnings: string[];
    };
    applyInfoPlistChanges: (
      infoPlist: Record<string, unknown>,
      options: { cliPins: string[]; allowPrivateLanOnly: boolean }
    ) => Record<string, unknown>;
    applyAndroidManifestChanges: (
      androidManifest: unknown,
      options: { cliPins: string[]; allowPrivateLanOnly: boolean }
    ) => unknown;
    NATIVE_TESTS_PODFILE_MARKER: string;
    addNativeTestsPodToPodfile: (podfile: string, podPath: string) => string;
  };
};

const {
  validatePins,
  configuredSchemes,
  normalizeOptions,
  applyInfoPlistChanges,
  applyAndroidManifestChanges,
  NATIVE_TESTS_PODFILE_MARKER,
  addNativeTestsPodToPodfile,
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
      /is not a valid SPKI pin/
    );
  });

  test("accepts a well-formed pin", () => {
    expect(validatePins([VALID_PIN])).toEqual([VALID_PIN]);
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
      {}
    );
    expect(options.allowPrivateLanOnly).toBe(false);
  });

  test("warns when deepLinkScheme is not declared in the Expo config's scheme field", () => {
    const { warnings } = normalizeOptions(
      { cliPins: [VALID_PIN], deepLinkScheme: "myapp" },
      { scheme: "otherapp" }
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("myapp");
  });

  test("does not warn when deepLinkScheme matches a string scheme", () => {
    const { warnings } = normalizeOptions(
      { cliPins: [VALID_PIN], deepLinkScheme: "myapp" },
      { scheme: "myapp" }
    );
    expect(warnings).toEqual([]);
  });

  test("does not warn when deepLinkScheme matches one entry of an array scheme", () => {
    const { warnings } = normalizeOptions(
      { cliPins: [VALID_PIN], deepLinkScheme: "myapp" },
      { scheme: ["otherapp", "myapp"] }
    );
    expect(warnings).toEqual([]);
  });

  test("does not warn when deepLinkScheme is omitted", () => {
    const { warnings } = normalizeOptions({ cliPins: [VALID_PIN] }, {});
    expect(warnings).toEqual([]);
  });

  test("propagates validatePins' throw for an invalid pin", () => {
    expect(() => normalizeOptions({ cliPins: ["bad"] }, {})).toThrow(
      /is not a valid SPKI pin/
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
  test("writes pins and a real boolean allowPrivateLanOnly", () => {
    const infoPlist = applyInfoPlistChanges(
      {},
      { cliPins: [VALID_PIN], allowPrivateLanOnly: true }
    );
    expect(infoPlist["CordieriteCliPins"]).toEqual([VALID_PIN]);
    expect(infoPlist["CordieriteAllowPrivateLanOnly"]).toBe(true);
    expect(typeof infoPlist["CordieriteAllowPrivateLanOnly"]).toBe("boolean");
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
        item.$["android:name"] === "com.callstackincubator.cordierite.CLI_PINS"
    );
    const privateLan = metaData.find(
      (item) =>
        item.$["android:name"] ===
        "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY"
    );

    expect(pins?.$["android:value"]).toBe(JSON.stringify([VALID_PIN]));
    // A real boolean survives in the in-memory manifest model (task 12: "write it in a form native
    // actually reads"), not a stringified `"true"` -- distinguishing this from the pre-task-12 bug.
    expect(privateLan?.$["android:value"]).toBe(true);
    expect(typeof privateLan?.$["android:value"]).toBe("boolean");
  });

  test("throws when the manifest has no MainApplication element", () => {
    expect(() =>
      applyAndroidManifestChanges(
        { manifest: { application: [] } },
        { cliPins: [VALID_PIN], allowPrivateLanOnly: true }
      )
    ).toThrow();
  });
});

describe("app.plugin.js: addNativeTestsPodToPodfile", () => {
  const podfile = `target 'playground' do\n  use_expo_modules!\nend\n`;

  test("adds the Cordierite test spec after Expo module setup", () => {
    expect(
      addNativeTestsPodToPodfile(podfile, "../../packages/react-native"),
    ).toContain(
      `${NATIVE_TESTS_PODFILE_MARKER}\n  pod 'Cordierite', :path => '../../packages/react-native', :testspecs => ['Tests']`,
    );
  });

  test("does not duplicate the test-spec pod on repeated prebuilds", () => {
    const once = addNativeTestsPodToPodfile(
      podfile,
      "../../packages/react-native",
    );
    expect(addNativeTestsPodToPodfile(once, "../../packages/react-native")).toBe(
      once,
    );
  });

  test("fails clearly when Expo changes the Podfile shape", () => {
    expect(() =>
      addNativeTestsPodToPodfile("target 'playground' do\nend\n", "../module"),
    ).toThrow(/no "  use_expo_modules!" anchor/);
  });
});
