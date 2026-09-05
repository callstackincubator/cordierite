/**
 * Deep-link scheme resolution (`scheme.ts`, issue #29): `app.json` discovery, the project-config
 * walk-up, and the precedence order shared by `cordierite link`, `cordierite mcp`,
 * `cordierite/client`'s `link()` and `cordierite_connect`.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  describeMissingScheme,
  discoverExpoScheme,
  findProjectConfig,
  isValidScheme,
  readProjectConfigScheme,
  resolveScheme,
  resolveSchemeOrThrow,
} from "../scheme.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { force: true, recursive: true });
  }
});

const makeDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "cordierite-scheme-"));
  directories.push(directory);

  return directory;
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value), "utf8");
};

const writeAppJson = async (dir: string, expo: unknown): Promise<void> => {
  await writeJson(path.join(dir, "app.json"), { expo });
};

const writeProjectConfig = async (dir: string, value: unknown): Promise<string> => {
  const configPath = path.join(dir, ".cordierite", "config.json");
  await writeJson(configPath, value);

  return configPath;
};

describe("isValidScheme", () => {
  test.each(["myapp", "my-app", "my.app", "my+app", "a", "Exp0"])("accepts %s", (value) => {
    expect(isValidScheme(value)).toBe(true);
  });

  // The rejected values are the ones a human actually types by mistake — a pasted URL prefix, a
  // leading digit, a space — each of which would otherwise compose an unopenable deep link.
  test.each(["myapp://", "myapp:", "1app", "my app", "", "-app", "my_app", "my/app"])(
    "rejects %s",
    (value) => {
      expect(isValidScheme(value)).toBe(false);
    },
  );
});

describe("discoverExpoScheme", () => {
  test("reads a string expo.scheme", async () => {
    const dir = await makeDir();
    await writeAppJson(dir, { scheme: "myapp" });

    expect(await discoverExpoScheme(dir)).toBe("myapp");
  });

  test("takes the first entry of an array expo.scheme, matching app.plugin.js", async () => {
    const dir = await makeDir();
    await writeAppJson(dir, { scheme: ["myapp", "myapp-dev"] });

    expect(await discoverExpoScheme(dir)).toBe("myapp");
  });

  test("skips empty entries in an array expo.scheme", async () => {
    const dir = await makeDir();
    await writeAppJson(dir, { scheme: ["", "myapp"] });

    expect(await discoverExpoScheme(dir)).toBe("myapp");
  });

  test("returns undefined when app.json is missing", async () => {
    expect(await discoverExpoScheme(await makeDir())).toBeUndefined();
  });

  test("returns undefined when app.json has no expo key", async () => {
    const dir = await makeDir();
    await writeJson(path.join(dir, "app.json"), { name: "Demo", scheme: "top-level-is-not-expo" });

    expect(await discoverExpoScheme(dir)).toBeUndefined();
  });

  test("returns undefined when expo declares no scheme", async () => {
    const dir = await makeDir();
    await writeAppJson(dir, { name: "Demo" });

    expect(await discoverExpoScheme(dir)).toBeUndefined();
  });

  test.each([
    ["an empty string scheme", ""],
    ["a numeric scheme", 7],
    ["a null scheme", null],
    ["an object scheme", { ios: "myapp" }],
    ["an array of non-strings", [7, true]],
  ])("returns undefined for %s", async (_label, scheme) => {
    const dir = await makeDir();
    await writeAppJson(dir, { scheme });

    expect(await discoverExpoScheme(dir)).toBeUndefined();
  });

  test("returns undefined when app.json is a JSON array rather than an object", async () => {
    const dir = await makeDir();
    await writeJson(path.join(dir, "app.json"), ["not", "a", "config"]);

    expect(await discoverExpoScheme(dir)).toBeUndefined();
  });

  test("returns undefined when app.json is a directory", async () => {
    const dir = await makeDir();
    await mkdir(path.join(dir, "app.json"));

    expect(await discoverExpoScheme(dir)).toBeUndefined();
  });

  test("throws a clear error when app.json is not valid JSON", async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, "app.json"), "{ this is not json", "utf8");

    await expect(discoverExpoScheme(dir)).rejects.toThrow(/Could not parse .*app\.json/u);
  });

  test("throws when expo.scheme is present but syntactically invalid", async () => {
    const dir = await makeDir();
    await writeAppJson(dir, { scheme: "myapp://" });

    await expect(discoverExpoScheme(dir)).rejects.toThrow(/Invalid deep-link scheme/u);
  });
});

describe("findProjectConfig", () => {
  test("finds a config in the starting directory (0 levels up)", async () => {
    const dir = await makeDir();
    const configPath = await writeProjectConfig(dir, { scheme: "myapp" });

    expect(findProjectConfig(dir)).toBe(configPath);
  });

  test.each([1, 2])("walks %i level(s) up to find one", async (levels) => {
    const root = await makeDir();
    const configPath = await writeProjectConfig(root, { scheme: "myapp" });
    const start = path.join(root, ...Array.from({ length: levels }, (_, i) => `level-${i}`));
    await mkdir(start, { recursive: true });

    expect(findProjectConfig(start)).toBe(configPath);
  });

  test("prefers the nearest config when several are on the path", async () => {
    const root = await makeDir();
    await writeProjectConfig(root, { scheme: "outer" });
    const inner = path.join(root, "packages", "app");
    await mkdir(inner, { recursive: true });
    const innerConfig = await writeProjectConfig(inner, { scheme: "inner" });

    expect(findProjectConfig(inner)).toBe(innerConfig);
  });

  // The walk terminates at the filesystem root rather than looping forever or stepping above it.
  test("stops at the filesystem root and returns undefined when nothing is found", async () => {
    const dir = await makeDir();
    const deep = path.join(dir, "a", "b", "c");
    await mkdir(deep, { recursive: true });

    expect(findProjectConfig(deep)).toBeUndefined();
    expect(findProjectConfig(path.parse(dir).root)).toBeUndefined();
  });

  test("skips the state directory so a global ~/.cordierite is never taken for a project config", async () => {
    const home = await makeDir();
    const stateDir = path.join(home, ".cordierite");
    await writeProjectConfig(home, { scheme: "global" });
    const projectDir = path.join(home, "app");
    await mkdir(projectDir, { recursive: true });

    expect(findProjectConfig(projectDir)).toBe(path.join(stateDir, "config.json"));
    expect(findProjectConfig(projectDir, stateDir)).toBeUndefined();
  });
});

describe("readProjectConfigScheme", () => {
  test("returns the scheme", async () => {
    const dir = await makeDir();
    const configPath = await writeProjectConfig(dir, { scheme: "myapp" });

    expect(await readProjectConfigScheme(configPath)).toBe("myapp");
  });

  test("returns undefined when the file has no scheme key", async () => {
    const dir = await makeDir();
    const configPath = await writeProjectConfig(dir, {});

    expect(await readProjectConfigScheme(configPath)).toBeUndefined();
  });

  test("ignores keys other than scheme, so a project file can never redirect daemon state", async () => {
    const dir = await makeDir();
    const configPath = await writeProjectConfig(dir, {
      scheme: "myapp",
      keyPath: "/tmp/attacker-key.pem",
      wssPort: 1,
    });

    expect(await readProjectConfigScheme(configPath)).toBe("myapp");
  });

  test.each([
    ["a non-object", ["myapp"]],
    ["an empty scheme", { scheme: "" }],
    ["a numeric scheme", { scheme: 7 }],
    ["an invalid scheme", { scheme: "myapp://" }],
  ])("throws for %s — this is Cordierite's own file", async (_label, value) => {
    const dir = await makeDir();
    const configPath = await writeProjectConfig(dir, value);

    await expect(readProjectConfigScheme(configPath)).rejects.toThrow();
  });

  test("throws for malformed JSON", async () => {
    const dir = await makeDir();
    const configPath = path.join(dir, ".cordierite", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "{ nope", "utf8");

    await expect(readProjectConfigScheme(configPath)).rejects.toThrow(/Could not parse/u);
  });
});

describe("resolveScheme precedence", () => {
  /** An app root carrying a scheme at every one of the five sources at once. */
  const makeFullyLoadedRoot = async (): Promise<{ cwd: string; stateDir: string }> => {
    const root = await makeDir();
    const cwd = path.join(root, "app");
    const stateDir = path.join(root, "state");
    await mkdir(cwd, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    await writeProjectConfig(cwd, { scheme: "from-project-config" });
    await writeAppJson(cwd, { scheme: "from-app-json" });

    return { cwd, stateDir };
  };

  const resolveWith = async (
    overrides: Parameters<typeof resolveScheme>[0] = {},
  ): Promise<Awaited<ReturnType<typeof resolveScheme>>> => {
    const { cwd, stateDir } = await makeFullyLoadedRoot();

    return resolveScheme({
      cwd,
      env: { CORDIERITE_SCHEME: "from-env" },
      configScheme: "from-state-config",
      stateConfigPath: path.join(stateDir, "config.json"),
      stateDirRoot: stateDir,
      ...overrides,
    });
  };

  test("1. --scheme wins over everything", async () => {
    expect(await resolveWith({ flagScheme: "from-flag" })).toMatchObject({
      scheme: "from-flag",
      source: "flag",
    });
  });

  test("2. CORDIERITE_SCHEME wins when there is no flag", async () => {
    expect(await resolveWith()).toMatchObject({ scheme: "from-env", source: "env" });
  });

  test("3. the project config wins when there is no flag or env", async () => {
    expect(await resolveWith({ env: {} })).toMatchObject({
      scheme: "from-project-config",
      source: "project-config",
    });
  });

  test("4. the state dir config wins over app.json", async () => {
    const { cwd, stateDir } = await makeFullyLoadedRoot();
    await rm(path.join(cwd, ".cordierite"), { force: true, recursive: true });

    expect(
      await resolveScheme({
        cwd,
        env: {},
        configScheme: "from-state-config",
        stateConfigPath: path.join(stateDir, "config.json"),
        stateDirRoot: stateDir,
      }),
    ).toMatchObject({ scheme: "from-state-config", source: "state-config" });
  });

  test("5. app.json is the last resort — the zero-config path from issue #29", async () => {
    const { cwd, stateDir } = await makeFullyLoadedRoot();
    await rm(path.join(cwd, ".cordierite"), { force: true, recursive: true });

    expect(
      await resolveScheme({ cwd, env: {}, stateDirRoot: stateDir }),
    ).toMatchObject({ scheme: "from-app-json", source: "app-json" });
  });

  test("an empty flag or env value falls through rather than resolving to nothing", async () => {
    const { cwd, stateDir } = await makeFullyLoadedRoot();
    await rm(path.join(cwd, ".cordierite"), { force: true, recursive: true });

    expect(
      await resolveScheme({
        flagScheme: "",
        env: { CORDIERITE_SCHEME: "" },
        cwd,
        stateDirRoot: stateDir,
      }),
    ).toMatchObject({ scheme: "from-app-json", source: "app-json" });
  });

  test("app.json discovery does not walk up — an app root is where these commands run", async () => {
    const root = await makeDir();
    await writeAppJson(root, { scheme: "from-parent-app-json" });
    const cwd = path.join(root, "nested");
    await mkdir(cwd, { recursive: true });

    expect((await resolveScheme({ cwd, env: {} })).scheme).toBeUndefined();
  });

  test("reports every location tried, in order, when nothing resolves", async () => {
    const dir = await makeDir();
    const stateConfigPath = path.join(dir, "state", "config.json");

    const { scheme, tried } = await resolveScheme({
      cwd: dir,
      env: {},
      stateConfigPath,
      stateDirRoot: path.join(dir, "state"),
    });

    expect(scheme).toBeUndefined();
    expect(tried).toEqual([
      "the --scheme flag",
      "the CORDIERITE_SCHEME environment variable",
      `.cordierite/config.json (searched upwards from ${dir})`,
      `${stateConfigPath} ("scheme")`,
      `${path.join(dir, "app.json")} ("expo.scheme")`,
    ]);
  });

  test("names the project config it actually found in the tried list", async () => {
    const dir = await makeDir();
    const configPath = await writeProjectConfig(dir, { notScheme: true });

    const { tried } = await resolveScheme({ cwd: dir, env: {} });

    expect(tried).toContain(configPath);
  });
});

describe("resolveSchemeOrThrow", () => {
  test("returns the resolved scheme", async () => {
    const dir = await makeDir();
    await writeAppJson(dir, { scheme: "myapp" });

    expect(await resolveSchemeOrThrow({ cwd: dir, env: {} })).toBe("myapp");
  });

  test("throws a usage error naming every location tried", async () => {
    const dir = await makeDir();

    await expect(resolveSchemeOrThrow({ cwd: dir, env: {} })).rejects.toThrow(
      /Looked in, in order:[\s\S]*CORDIERITE_SCHEME[\s\S]*app\.json/u,
    );
  });
});

describe("describeMissingScheme", () => {
  test("numbers the locations and names every way to set one", () => {
    const message = describeMissingScheme(["the --scheme flag", "/tmp/app.json"]);

    expect(message).toContain("1. the --scheme flag");
    expect(message).toContain("2. /tmp/app.json");
    expect(message).toContain("CORDIERITE_SCHEME");
    expect(message).toContain("cordierite init");
  });

  test("omits the list rather than printing an empty one", () => {
    expect(describeMissingScheme([])).not.toContain("Looked in");
  });
});
