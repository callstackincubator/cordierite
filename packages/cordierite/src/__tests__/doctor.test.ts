import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { handleDoctorCommand } from "../commands/doctor.js";
import type { ExecBufferFn } from "../artifact-inspect.js";
import { buildZipFixture, makeFixtureRoot } from "./artifact-fixtures.js";

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

describe("doctor command", () => {
  test("no --assert flag: reports present/absent without throwing", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/callstackincubator/cordierite/X;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    const result = await handleDoctorCommand({ artifactPath: apkPath });

    expect(result).toMatchObject({
      ok: true,
      data: { present: true, platform: "android", format: "apk" },
    });
    expect(result.ok && result.data.assertion).toBeUndefined();
  });

  test("--assert-present holds when Cordierite is present", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/callstackincubator/cordierite/X;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    const result = await handleDoctorCommand({ artifactPath: apkPath, assertPresent: true });

    expect(result.ok && result.data.assertion).toEqual({ expected: "present", holds: true });
  });

  test("--assert-present throws assertion_error when Cordierite is absent", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "excluded.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/example/app/MainActivity;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    await expect(
      handleDoctorCommand({ artifactPath: apkPath, assertPresent: true }),
    ).rejects.toMatchObject({
      type: "assertion_error",
      details: expect.objectContaining({ present: false }),
    });
  });

  test("--assert-absent holds when Cordierite is absent", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "excluded.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/example/app/MainActivity;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    const result = await handleDoctorCommand({ artifactPath: apkPath, assertAbsent: true });

    expect(result.ok && result.data.assertion).toEqual({ expected: "absent", holds: true });
  });

  test("--assert-absent throws assertion_error when Cordierite is present", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included.apk");
    await buildZipFixture(apkPath, {
      "classes.dex": "Lcom/callstackincubator/cordierite/X;",
      "AndroidManifest.xml": "placeholder manifest",
    });

    await expect(
      handleDoctorCommand({ artifactPath: apkPath, assertAbsent: true }),
    ).rejects.toMatchObject({
      type: "assertion_error",
      details: expect.objectContaining({ present: true }),
    });
  });

  test("--assert-present and --assert-absent together is a usage_error", async () => {
    await expect(
      handleDoctorCommand({ artifactPath: "irrelevant.apk", assertPresent: true, assertAbsent: true }),
    ).rejects.toMatchObject({ type: "usage_error" });
  });

  test("a missing artifact path argument is a usage_error", async () => {
    await expect(handleDoctorCommand({})).rejects.toMatchObject({ type: "usage_error" });
  });

  test("a missing external tool surfaces as inspection_error, not a false assertion pass/fail", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "unreachable.apk");
    await writeFile(apkPath, "irrelevant: exec is mocked to fail before this is read");

    const enoentExec: ExecBufferFn = async () => {
      const error = new Error("spawn unzip ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };

    // Even with --assert-absent given (which a false "not present" would otherwise satisfy), a
    // missing tool must surface as inspection_error, never a silently-passing assertion.
    await expect(
      handleDoctorCommand(
        { artifactPath: apkPath, assertAbsent: true },
        { exec: enoentExec },
      ),
    ).rejects.toMatchObject({ type: "inspection_error" });
  });
});
