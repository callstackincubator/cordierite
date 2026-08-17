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
  trust: "link" | "pin";
  cliPins: string[];
  allowPrivateLanOnly: boolean;
  deepLinkScheme: string | undefined;
};

const cordieritePlugin = require("../../app.plugin.js") as ((
  config: Record<string, unknown>,
  options?: Record<string, unknown>,
) => { mods?: Record<string, unknown> }) & {
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
  };
};

const {
  validatePins,
  configuredSchemes,
  normalizeOptions,
  applyInfoPlistChanges,
  applyAndroidManifestChanges,
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
  test("enableInReleaseBuilds throws, naming CORDIERITE_ENABLED/trust", () => {
    expect(() => normalizeOptions({ enableInReleaseBuilds: true }, {})).toThrow(
      /"enableInReleaseBuilds" has been removed/,
    );
    expect(() => normalizeOptions({ enableInReleaseBuilds: true }, {})).toThrow(
      /CORDIERITE_ENABLED/,
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

  test("include throws, naming CORDIERITE_ENABLED (both values -- the option is gone)", () => {
    for (const value of [true, false]) {
      expect(() => normalizeOptions({ include: value }, {})).toThrow(
        /"include" has been removed/,
      );
      expect(() => normalizeOptions({ include: value }, {})).toThrow(
        /CORDIERITE_ENABLED/,
      );
    }
  });

  test("an unparseable CORDIERITE_ENABLED fails at prebuild, where a throw actually stops the build", () => {
    const previous = process.env.CORDIERITE_ENABLED;
    process.env.CORDIERITE_ENABLED = "flase";
    try {
      expect(() => normalizeOptions({}, {})).toThrow(/CORDIERITE_ENABLED/);
    } finally {
      if (previous === undefined) {
        delete process.env.CORDIERITE_ENABLED;
      } else {
        process.env.CORDIERITE_ENABLED = previous;
      }
    }
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

describe("app.plugin.js: CORDIERITE_ENABLED=0 leaves no footprint", () => {
  const withEnv = (value: string | undefined, run: () => void) => {
    const previous = process.env.CORDIERITE_ENABLED;
    if (value === undefined) {
      delete process.env.CORDIERITE_ENABLED;
    } else {
      process.env.CORDIERITE_ENABLED = value;
    }
    try {
      run();
    } finally {
      if (previous === undefined) {
        delete process.env.CORDIERITE_ENABLED;
      } else {
        process.env.CORDIERITE_ENABLED = previous;
      }
    }
  };

  // `artifact-inspect.ts` treats CLI_PINS/TRUST as an inclusion signal, so a plugin that still
  // wrote them into an excluded build would fail `doctor --assert-absent` on a genuinely clean
  // artifact -- the regression this guards.
  const runPlugin = () =>
    cordieritePlugin(
      { name: "app", _internal: { projectRoot: "/tmp/app" } },
      { cliPins: [VALID_PIN] },
    ) as { mods?: Record<string, unknown> };

  test("registers no Info.plist or manifest mods", () => {
    withEnv("0", () => {
      expect(runPlugin().mods).toBeUndefined();
    });
  });

  test("registers both platforms' mods when enabled", () => {
    withEnv(undefined, () => {
      const mods = runPlugin().mods;
      expect(mods?.ios).toBeDefined();
      expect(mods?.android).toBeDefined();
    });
  });
});

describe("app.plugin.js: applyInfoPlistChanges", () => {
  test("writes pins, trust, and a real boolean allowPrivateLanOnly", () => {
    const infoPlist = applyInfoPlistChanges(
      {},
      {
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
          trust: "pin",
          cliPins: [VALID_PIN],
          allowPrivateLanOnly: true,
          deepLinkScheme: undefined,
        },
      ),
    ).toThrow();
  });
});
