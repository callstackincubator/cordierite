import { createRequire } from "node:module";

import { describe, expect, test, vi } from "vitest";

// `metro.js` is a CommonJS helper at the package root, not a TS module under `src/` -- see
// `app-plugin.test.ts` for the same pattern with `app.plugin.js`. `createRequire` loads it
// without adding a `require` ambient declaration to this test file.
const require = createRequire(import.meta.url);

const cordieriteMetro = require("../../metro.js") as {
  withCordierite: (config: unknown, options?: { include?: boolean }) => {
    resolver?: { resolveRequest?: MetroResolveRequest };
    [key: string]: unknown;
  };
  __testables: {
    deriveRedirectSpecifiers: (
      exportsField: Record<string, unknown>,
    ) => string[];
    specifierForSubpath: (subpath: string) => string;
    NOOP_SPECIFIER: string;
    PACKAGE_NAME: string;
  };
};

type MetroResolveRequest = (
  context: { resolveRequest: MetroResolveRequest },
  moduleName: string,
  platform: string | null,
) => { type: "sourceFile"; filePath: string };

function fakeResolution(moduleName: string) {
  return { type: "sourceFile" as const, filePath: `/resolved/${moduleName}` };
}

/** Metro's own default resolver stand-in: resolves whatever it's asked to resolve. */
function makeDefaultResolveRequest(): MetroResolveRequest {
  return vi.fn((_context, moduleName: string) => fakeResolution(moduleName));
}

function makeContext(resolveRequest: MetroResolveRequest) {
  return { resolveRequest };
}

const { withCordierite, __testables } = cordieriteMetro;
const { deriveRedirectSpecifiers, specifierForSubpath, NOOP_SPECIFIER, PACKAGE_NAME } =
  __testables;

describe("withCordierite: default (include unset / true)", () => {
  test("returns the config untouched -- no resolver installed", () => {
    const config = { resolver: { sourceExts: ["ts"] } };
    const result = withCordierite(config);
    expect(result).toBe(config);
  });

  test("explicit include: true also leaves the config untouched", () => {
    const config = { resolver: { sourceExts: ["ts"] } };
    const result = withCordierite(config, { include: true });
    expect(result).toBe(config);
  });
});

describe("withCordierite: include: false", () => {
  test("redirects the root entry to /noop", () => {
    const defaultResolveRequest = makeDefaultResolveRequest();
    const config = { resolver: {} };
    const result = withCordierite(config, { include: false });
    const resolveRequest = result.resolver!.resolveRequest!;

    const resolution = resolveRequest(
      makeContext(defaultResolveRequest),
      PACKAGE_NAME,
      "ios",
    );

    expect(resolution).toEqual(fakeResolution(NOOP_SPECIFIER));
    expect(defaultResolveRequest).toHaveBeenCalledWith(
      expect.anything(),
      NOOP_SPECIFIER,
      "ios",
    );
  });

  test("redirects the /auto entry to /noop", () => {
    const defaultResolveRequest = makeDefaultResolveRequest();
    const config = { resolver: {} };
    const result = withCordierite(config, { include: false });
    const resolveRequest = result.resolver!.resolveRequest!;

    const resolution = resolveRequest(
      makeContext(defaultResolveRequest),
      `${PACKAGE_NAME}/auto`,
      "android",
    );

    expect(resolution).toEqual(fakeResolution(NOOP_SPECIFIER));
  });

  test("never redirects /noop itself", () => {
    const defaultResolveRequest = makeDefaultResolveRequest();
    const config = { resolver: {} };
    const result = withCordierite(config, { include: false });
    const resolveRequest = result.resolver!.resolveRequest!;

    const resolution = resolveRequest(
      makeContext(defaultResolveRequest),
      NOOP_SPECIFIER,
      "ios",
    );

    expect(resolution).toEqual(fakeResolution(NOOP_SPECIFIER));
    expect(defaultResolveRequest).toHaveBeenCalledWith(
      expect.anything(),
      NOOP_SPECIFIER,
      "ios",
    );
  });

  test("passes an unrelated specifier through untouched", () => {
    const defaultResolveRequest = makeDefaultResolveRequest();
    const config = { resolver: {} };
    const result = withCordierite(config, { include: false });
    const resolveRequest = result.resolver!.resolveRequest!;

    const resolution = resolveRequest(makeContext(defaultResolveRequest), "react", "ios");

    expect(resolution).toEqual(fakeResolution("react"));
    expect(defaultResolveRequest).toHaveBeenCalledWith(expect.anything(), "react", "ios");
  });

  test("chains to an existing resolveRequest and honours its result, for both redirected and passthrough specifiers", () => {
    const existingResolveRequest = vi.fn((_context, moduleName: string) => ({
      type: "sourceFile" as const,
      filePath: `/custom-resolver/${moduleName}`,
    }));
    const config = { resolver: { resolveRequest: existingResolveRequest } };
    const result = withCordierite(config, { include: false });
    const resolveRequest = result.resolver!.resolveRequest!;
    const fallbackContext = makeContext(makeDefaultResolveRequest());

    const redirected = resolveRequest(fallbackContext, PACKAGE_NAME, "ios");
    const passthrough = resolveRequest(fallbackContext, "react-native", "ios");

    // The existing resolver ran -- not Metro's default -- and its return value is what callers see.
    expect(redirected).toEqual({
      type: "sourceFile",
      filePath: `/custom-resolver/${NOOP_SPECIFIER}`,
    });
    expect(passthrough).toEqual({
      type: "sourceFile",
      filePath: "/custom-resolver/react-native",
    });
    expect(existingResolveRequest).toHaveBeenCalledTimes(2);
    // The context's own resolveRequest (Metro's default) is never invoked when an existing
    // resolver is present -- it would otherwise resolve the module twice.
    expect(fallbackContext.resolveRequest).not.toHaveBeenCalled();
  });

  test("does not mutate the passed-in config object", () => {
    const originalResolveRequest = vi.fn();
    const config = { resolver: { resolveRequest: originalResolveRequest, sourceExts: ["ts"] } };
    withCordierite(config, { include: false });

    expect(config.resolver.resolveRequest).toBe(originalResolveRequest);
  });
});

describe("deriveRedirectSpecifiers: derived from exports, not hardcoded", () => {
  test("the real package.json's exports produce exactly the root and /auto entries", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json") as { exports: Record<string, unknown> };
    const specifiers = deriveRedirectSpecifiers(pkg.exports).sort();

    expect(specifiers).toEqual([PACKAGE_NAME, `${PACKAGE_NAME}/auto`].sort());
  });

  test("a new conditions-map entry point is picked up automatically", () => {
    const exportsField = {
      ".": { default: "./build/index.js" },
      "./auto": { default: "./build/auto.js" },
      "./noop": { default: "./build/noop.js" },
      "./future-entry": { default: "./build/future-entry.js" },
      "./package.json": "./package.json",
    };

    const specifiers = deriveRedirectSpecifiers(exportsField);

    expect(specifiers).toContain(`${PACKAGE_NAME}/future-entry`);
  });

  test("string-valued (non-module) exports are never included, and /noop is always excluded", () => {
    const exportsField = {
      ".": { default: "./build/index.js" },
      "./noop": { default: "./build/noop.js" },
      "./package.json": "./package.json",
      "./app.plugin.js": "./app.plugin.js",
      "./metro": "./metro.js",
    };

    const specifiers = deriveRedirectSpecifiers(exportsField);

    expect(specifiers).toEqual([PACKAGE_NAME]);
  });
});

describe("specifierForSubpath", () => {
  test("maps '.' to the bare package name", () => {
    expect(specifierForSubpath(".")).toBe(PACKAGE_NAME);
  });

  test("maps a subpath to package/subpath", () => {
    expect(specifierForSubpath("./auto")).toBe(`${PACKAGE_NAME}/auto`);
  });
});
