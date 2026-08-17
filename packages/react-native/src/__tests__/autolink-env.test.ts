import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";

// `autolink-env.js` is a CommonJS helper at the package root, not a TS module under `src/` --
// see `metro.test.ts` for the same pattern with `metro.js`.
const require = createRequire(import.meta.url);

const autolinkEnv = require("../../autolink-env.js") as {
  isCordieriteAutolinkEnabled: (env?: NodeJS.ProcessEnv) => boolean;
  parseCordieriteEnabled: (env?: NodeJS.ProcessEnv) => "unset" | boolean;
  ENV_VAR: string;
};

const { isCordieriteAutolinkEnabled, parseCordieriteEnabled, ENV_VAR } =
  autolinkEnv;

describe("parseCordieriteEnabled", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test('unset -> "unset"', () => {
    delete process.env[ENV_VAR];
    expect(parseCordieriteEnabled()).toBe("unset");
  });

  test('empty string -> "unset"', () => {
    process.env[ENV_VAR] = "  ";
    expect(parseCordieriteEnabled()).toBe("unset");
  });

  test.each(["1", "true", "True"])("%s -> true", (value) => {
    process.env[ENV_VAR] = value;
    expect(parseCordieriteEnabled()).toBe(true);
  });

  test.each(["0", "false", "False"])("%s -> false", (value) => {
    process.env[ENV_VAR] = value;
    expect(parseCordieriteEnabled()).toBe(false);
  });

  test("unrecognized value throws, naming the offending value", () => {
    process.env[ENV_VAR] = "nope";
    expect(() => parseCordieriteEnabled()).toThrow(/"nope"/);
  });
});

describe("isCordieriteAutolinkEnabled", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test("unset -> true (present in at least the dev build)", () => {
    delete process.env[ENV_VAR];
    expect(isCordieriteAutolinkEnabled()).toBe(true);
  });

  test("truthy -> true", () => {
    process.env[ENV_VAR] = "1";
    expect(isCordieriteAutolinkEnabled()).toBe(true);
  });

  test("falsy -> false", () => {
    process.env[ENV_VAR] = "0";
    expect(isCordieriteAutolinkEnabled()).toBe(false);
  });
});
