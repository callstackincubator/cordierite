/**
 * The version every part of Cordierite reports (issue #30). The check that decides whether to
 * replace a running daemon is only as trustworthy as these two functions: a client that misreports
 * its version compares a lie to a lie, and a daemon that misreports its version in production
 * makes every command restart it forever.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  DAEMON_VERSION_OVERRIDE_ENV,
  getDaemonReportedVersion,
  getPackageVersion,
} from "../package-version.js";
import { packageRoot } from "./fixtures.js";

const REAL_VERSION: string = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
).version;

describe("package version", () => {
  test("getPackageVersion reads this package's real version", () => {
    expect(getPackageVersion()).toBe(REAL_VERSION);
  });

  test("the daemon honors the version override only under a test runner", () => {
    const override = "0.0.1-stale";

    expect(getDaemonReportedVersion({ VITEST: "true", [DAEMON_VERSION_OVERRIDE_ENV]: override })).toBe(
      override,
    );
    expect(
      getDaemonReportedVersion({ NODE_ENV: "test", [DAEMON_VERSION_OVERRIDE_ENV]: override }),
    ).toBe(override);

    // The failure this guards against: an operator with the variable exported in their shell would
    // otherwise have every daemon report a version no client can match, so every command would
    // restart it, and the replacement would inherit the same lie.
    expect(getDaemonReportedVersion({ [DAEMON_VERSION_OVERRIDE_ENV]: override })).toBe(REAL_VERSION);
    expect(
      getDaemonReportedVersion({ NODE_ENV: "production", [DAEMON_VERSION_OVERRIDE_ENV]: override }),
    ).toBe(REAL_VERSION);
  });

  test("an empty override is ignored even under a test runner", () => {
    expect(getDaemonReportedVersion({ VITEST: "true", [DAEMON_VERSION_OVERRIDE_ENV]: "" })).toBe(
      REAL_VERSION,
    );
    expect(getDaemonReportedVersion({ VITEST: "true" })).toBe(REAL_VERSION);
  });
});
