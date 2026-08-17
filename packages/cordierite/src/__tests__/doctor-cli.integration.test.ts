/**
 * CLI-wiring coverage for `cordierite doctor`: exercises the real `create-cli.ts` ->
 * `dispatch.ts` -> `handleDoctorCommand` -> `output.ts` round trip (in-process via `runCli`, not
 * the daemon — `doctor` never touches it), on top of the handler-level coverage in
 * `doctor.test.ts`/`artifact-inspect.test.ts`.
 */
import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildZipFixture, makeFixtureRoot } from "./artifact-fixtures.js";
import { runCliWithCapture } from "./fixtures.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    await rm(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

const withFixtureRoot = async (): Promise<string> => {
  const root = await makeFixtureRoot();
  cleanupDirs.push(root);
  return root;
};

describe("cordierite doctor: CLI wiring", () => {
  test("exit 0, ok:true JSON when Cordierite is present and no assertion was requested", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/callstackincubator/cordierite/X;Lcom/callstackincubator/cordierite/CordieriteNativeMarker;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    const result = await runCliWithCapture(["doctor", apkPath, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: true, data: { present: true, platform: "android" } });
  });

  test("exit 0 for --assert-present against an included artifact", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/callstackincubator/cordierite/X;Lcom/callstackincubator/cordierite/CordieriteNativeMarker;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    const result = await runCliWithCapture(["doctor", apkPath, "--assert-present", "--json"]);

    expect(result.exitCode).toBe(0);
  });

  test("exit 3 (assertion_error) for --assert-absent against an included artifact", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/callstackincubator/cordierite/X;Lcom/callstackincubator/cordierite/CordieriteNativeMarker;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    const result = await runCliWithCapture(["doctor", apkPath, "--assert-absent", "--json"]);

    expect(result.exitCode).toBe(3);
    const payload = JSON.parse(result.stdout);
    expect(payload.error.type).toBe("assertion_error");
  });

  test("exit 3 (assertion_error) for --assert-present against an excluded artifact", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "excluded.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/example/app/MainActivity;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    const result = await runCliWithCapture(["doctor", apkPath, "--assert-present", "--json"]);

    expect(result.exitCode).toBe(3);
    const payload = JSON.parse(result.stdout);
    expect(payload.error.type).toBe("assertion_error");
  });

  test("exit 66 (inspection_error) for a corrupt/unreadable artifact — never a false pass or fail", async () => {
    const root = await withFixtureRoot();
    const { writeFile } = await import("node:fs/promises");
    const badPath = path.join(root, "corrupt.apk");
    await writeFile(badPath, "not a zip file");

    const result = await runCliWithCapture(["doctor", badPath, "--assert-absent", "--json"]);

    expect(result.exitCode).toBe(66);
    const payload = JSON.parse(result.stdout);
    expect(payload.error.type).toBe("inspection_error");
  });

  test("exit 64 (usage_error) for an unrecognized artifact extension", async () => {
    const root = await withFixtureRoot();
    const { writeFile } = await import("node:fs/promises");
    const weirdPath = path.join(root, "not-an-artifact.txt");
    await writeFile(weirdPath, "irrelevant");

    const result = await runCliWithCapture(["doctor", weirdPath, "--json"]);

    expect(result.exitCode).toBe(64);
  });

  test("exit 64 (usage_error) when both --assert-present and --assert-absent are given", async () => {
    const result = await runCliWithCapture([
      "doctor",
      "irrelevant.apk",
      "--assert-present",
      "--assert-absent",
      "--json",
    ]);

    expect(result.exitCode).toBe(64);
  });

  test("human-readable output names the artifact, platform, and presence", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/callstackincubator/cordierite/X;Lcom/callstackincubator/cordierite/CordieriteNativeMarker;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    const result = await runCliWithCapture(["doctor", apkPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Present");
    expect(result.stdout).toContain("android");
  });
});
