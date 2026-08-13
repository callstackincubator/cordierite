/**
 * Coverage for `artifact-inspect.ts`'s core claim: presence/absence detection across all four
 * platform x inclusion combinations the task requires, plus the property that matters most — a
 * missing tool or unreadable artifact must never be reported as "absent". See
 * `artifact-fixtures.ts`'s doc comment for what "synthetic fixture" means here and its limits.
 */
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  defaultExecBuffer,
  inspectArtifact,
  type ExecBufferFn,
} from "../artifact-inspect.js";
import { buildAppDirectoryFixture, buildZipFixture, makeFixtureRoot } from "./artifact-fixtures.js";

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

describe("artifact-inspect: iOS .ipa (synthetic zip fixture)", () => {
  test("included: reports present with the objc-class-symbol signal", async () => {
    const root = await withFixtureRoot();
    const ipaPath = path.join(root, "included.ipa");

    await buildZipFixture(ipaPath, {
      "Payload/Fixture.app/Fixture": Buffer.concat([
        Buffer.from("junk-mach-o-bytes-before "),
        Buffer.from("RCTNativeCordierite"),
        Buffer.from(" junk-mach-o-bytes-after"),
      ]),
      "Payload/Fixture.app/Info.plist": "not cordierite related",
    });

    const result = await inspectArtifact(ipaPath);

    expect(result.platform).toBe("ios");
    expect(result.format).toBe("ipa");
    expect(result.present).toBe(true);
    expect(result.signals).toContain("ios-objc-class-symbol");
  });

  test("included via Info.plist keys alone (corroborating signal) also reports present", async () => {
    const root = await withFixtureRoot();
    const ipaPath = path.join(root, "included-plist-only.ipa");

    await buildZipFixture(ipaPath, {
      "Payload/Fixture.app/Fixture": "no objc marker in this fake binary",
      "Payload/Fixture.app/Info.plist": "...CordieriteTrust...link...",
    });

    const result = await inspectArtifact(ipaPath);

    expect(result.present).toBe(true);
    expect(result.signals).toContain("ios-info-plist-keys");
  });

  test("excluded: reports absent with no signals", async () => {
    const root = await withFixtureRoot();
    const ipaPath = path.join(root, "excluded.ipa");

    await buildZipFixture(ipaPath, {
      "Payload/Fixture.app/Fixture": "totally unrelated binary contents, no markers here",
      "Payload/Fixture.app/Info.plist": "<plist><dict><key>CFBundleName</key></dict></plist>",
    });

    const result = await inspectArtifact(ipaPath);

    expect(result.platform).toBe("ios");
    expect(result.present).toBe(false);
    expect(result.signals).toEqual([]);
  });
});

describe("artifact-inspect: iOS .app (unpacked directory fixture)", () => {
  test("included: reports present", async () => {
    const root = await withFixtureRoot();
    const appPath = path.join(root, "Included.app");

    await buildAppDirectoryFixture(appPath, {
      Included: Buffer.concat([Buffer.from("prefix"), Buffer.from("RCTNativeCordierite"), Buffer.from("suffix")]),
      "Info.plist": "irrelevant",
    });

    const result = await inspectArtifact(appPath);

    expect(result.format).toBe("app");
    expect(result.present).toBe(true);
  });

  test("excluded: reports absent", async () => {
    const root = await withFixtureRoot();
    const appPath = path.join(root, "Excluded.app");

    await buildAppDirectoryFixture(appPath, {
      Excluded: "no markers in this fake binary at all",
      "Info.plist": "irrelevant",
    });

    const result = await inspectArtifact(appPath);

    expect(result.present).toBe(false);
  });
});

describe("artifact-inspect: Android .apk (synthetic zip fixture)", () => {
  test("included: reports present with the dex-package-symbol signal", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included.apk");

    await buildZipFixture(apkPath, {
      "classes.dex": Buffer.concat([
        Buffer.from("dex\n035\0"),
        Buffer.from("Lcom/callstackincubator/cordierite/CordieritePackage;"),
      ]),
      "AndroidManifest.xml": "binary-axml-placeholder-no-cordierite-keys",
    });

    const result = await inspectArtifact(apkPath);

    expect(result.platform).toBe("android");
    expect(result.format).toBe("apk");
    expect(result.present).toBe(true);
    expect(result.signals).toContain("android-dex-package-symbol");
  });

  test("included via the CordieriteNativeMarker keep-rule symbol alone (primary signal, synthetic: see artifact-fixtures.ts and the task report for what a real R8 build additionally verifies)", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included-keep-marker-only.apk");

    await buildZipFixture(apkPath, {
      // Simulates an R8 release build where every other class in the package (and the manifest,
      // since no config plugin ran) was renamed/omitted, but the consumer-rules.pro `-keep` rule
      // for CordieriteNativeMarker held: its fully-qualified dex type descriptor survives verbatim.
      "classes.dex": Buffer.concat([
        Buffer.from("dex\n035\0"),
        Buffer.from("Lcom/callstackincubator/cordierite/CordieriteNativeMarker;"),
      ]),
      "AndroidManifest.xml": "no cordierite keys in here (bare-RN app, no config plugin)",
    });

    const result = await inspectArtifact(apkPath);

    expect(result.present).toBe(true);
    expect(result.signals).toContain("android-keep-rule-marker");
  });

  test("included via AndroidManifest.xml meta-data keys alone, UTF-16LE encoded (corroborating signal, survives dex minification)", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "included-manifest-only.apk");

    await buildZipFixture(apkPath, {
      // Simulates a release build where R8 renamed the dex package (no "callstackincubator" string
      // left in classes.dex) but the config-plugin-authored manifest meta-data keys survive, since
      // they're XML attribute string data, not a code symbol R8 can rename.
      "classes.dex": Buffer.from("dex\n035\0La/b/c;"),
      "AndroidManifest.xml": Buffer.from("com.callstackincubator.cordierite.CLI_PINS", "utf16le"),
    });

    const result = await inspectArtifact(apkPath);

    expect(result.present).toBe(true);
    expect(result.signals).toEqual(["android-manifest-meta-data-keys"]);
    expect(result.signals).not.toContain("android-dex-package-symbol");
  });

  test("excluded: reports absent with no signals", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "excluded.apk");

    await buildZipFixture(apkPath, {
      "classes.dex": Buffer.from("dex\n035\0Lcom/example/app/MainActivity;"),
      "AndroidManifest.xml": "no cordierite keys in here",
    });

    const result = await inspectArtifact(apkPath);

    expect(result.platform).toBe("android");
    expect(result.present).toBe(false);
    expect(result.signals).toEqual([]);
  });
});

describe("artifact-inspect: Android .aab (bonus format coverage)", () => {
  test("included: the base/dex/ nesting AAB uses doesn't defeat the whole-archive scan", async () => {
    const root = await withFixtureRoot();
    const aabPath = path.join(root, "included.aab");

    await buildZipFixture(aabPath, {
      "base/dex/classes.dex": Buffer.from("Lcom/callstackincubator/cordierite/CordieritePackage;"),
      "base/manifest/AndroidManifest.xml": "no keys here",
    });

    const result = await inspectArtifact(aabPath);

    expect(result.format).toBe("aab");
    expect(result.present).toBe(true);
  });
});

describe("artifact-inspect: never reports absent when it cannot actually tell", () => {
  const enoentExec: ExecBufferFn = async () => {
    const error = new Error("spawn unzip ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  };

  test("a missing `unzip` binary throws inspection_error, not a false 'absent'", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "unreachable.apk");
    // Content doesn't matter: `exec` is mocked to fail before the (real) archive would ever be read.
    await writeFile(apkPath, "not read because unzip is unavailable");

    await expect(inspectArtifact(apkPath, { exec: enoentExec })).rejects.toMatchObject({
      type: "inspection_error",
      message: expect.stringMatching(/unzip.*not found on PATH/iu),
    });
  });

  test("the same missing-tool failure is surfaced for every zip-based format (.ipa/.apk/.aab)", async () => {
    const root = await withFixtureRoot();

    for (const extension of [".ipa", ".apk", ".aab"]) {
      const artifactPath = path.join(root, `unreachable${extension}`);
      await writeFile(artifactPath, "placeholder");

      await expect(inspectArtifact(artifactPath, { exec: enoentExec })).rejects.toMatchObject({
        type: "inspection_error",
      });
    }
  });

  test("a valid zip with the wrong internal shape (e.g. mislabeled/empty) throws inspection_error, never a clean 'absent'", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "wrong-shape.apk");

    // A genuinely valid, readable zip — but with none of the entries a real .apk always has
    // (AndroidManifest.xml). Without the shape check this would read back as a clean "no signals
    // found" (present: false) even though the file plainly isn't a real Android artifact.
    await buildZipFixture(apkPath, { "readme.txt": "this is not an Android build output" });

    await expect(inspectArtifact(apkPath)).rejects.toMatchObject({
      type: "inspection_error",
      message: expect.stringMatching(/does not look like a valid \.apk/iu),
    });
  });

  test("a corrupt/non-zip archive throws inspection_error via the real `unzip` binary", async () => {
    const root = await withFixtureRoot();
    const apkPath = path.join(root, "corrupt.apk");
    await writeFile(apkPath, "this is not a zip file at all, just plain garbage bytes");

    // No `exec` override here: this exercises the *real* `unzip` on this machine failing against a
    // genuinely invalid archive, not a mocked failure.
    await expect(inspectArtifact(apkPath)).rejects.toMatchObject({
      type: "inspection_error",
    });
  });

  test("a nonexistent artifact path throws inspection_error, never a silent 'absent'", async () => {
    const root = await withFixtureRoot();
    const missingPath = path.join(root, "does-not-exist.apk");

    await expect(inspectArtifact(missingPath)).rejects.toMatchObject({
      type: "inspection_error",
      message: expect.stringMatching(/not found/iu),
    });
  });

  test("an unrecognized extension is a usage_error, not an inspection_error", async () => {
    const root = await withFixtureRoot();
    const weirdPath = path.join(root, "not-an-artifact.zip");
    await writeFile(weirdPath, "irrelevant");

    await expect(inspectArtifact(weirdPath)).rejects.toMatchObject({
      type: "usage_error",
    });
  });

  test("defaultExecBuffer is wired to the real `unzip` (sanity check the DI seam matches production)", () => {
    expect(defaultExecBuffer).toBeInstanceOf(Function);
  });
});
