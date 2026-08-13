/**
 * Test-only fixture builders for `artifact-inspect.test.ts`/`doctor.test.ts`. These are
 * **synthetic** artifacts — plain files with marker strings dropped into a real zip container via
 * the `zip` CLI, not actual Xcode/Gradle build output. That's a deliberate scope choice for this
 * sandboxed environment (no Xcode/Android SDK toolchain to produce a real signed `.ipa`/`.apk`
 * here): `inspectArtifact` never parses Mach-O load commands, dex bytecode, or binary-plist/AXML
 * structure — it does a raw byte-substring scan over decompressed archive contents (see
 * `artifact-inspect.ts`'s doc comment) — so a synthetic archive with the right bytes in the right
 * *container* shape (a real zip, a real `.app` directory), genuinely deflate-compressed (see
 * `padForDeflate` below — this is not incidental), exercises the exact same code path a real build
 * artifact would. What it does **not** exercise is whether a real Xcode/Gradle release build
 * actually produces those marker bytes in the first place (e.g. Android R8 renaming symbols) — see
 * `artifact-inspect.ts`'s doc comment and the task report for that caveat.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type FixtureEntries = Record<string, string | Buffer>;

/** Highly-compressible padding wrapped around every zip-fixture entry's real content. Without
 * this, `zip` stores small marker-only files verbatim (method "Stored", 0% compression) rather
 * than deflating them, and a detector that skipped `unzip -p`'s decompression step entirely —
 * e.g. one that regressed to grepping the raw archive bytes — would still pass every test. Padding
 * each entry past `zip`'s stored-vs-deflate threshold forces the real archive to use "Defl:N"
 * (verified locally: a marker string alone stores at 0% compression; the same string surrounded by
 * this padding compresses at ~100%), so these fixtures only pass if `inspectArtifact` actually goes
 * through decompression, the same as it would against a real build artifact's compressed entries. */
const COMPRESSIBLE_PADDING = "0".repeat(20_000);

const padForDeflate = (contents: string | Buffer): Buffer => {
  const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  return Buffer.concat([Buffer.from(COMPRESSIBLE_PADDING), body, Buffer.from(COMPRESSIBLE_PADDING)]);
};

const writeEntries = async (rootDir: string, entries: FixtureEntries): Promise<void> => {
  for (const [relativePath, contents] of Object.entries(entries)) {
    const filePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, padForDeflate(contents));
  }
};

/** Builds a real zip archive at `zipPath` from a flat map of relative path -> file contents, via
 * the `zip` CLI. Every entry is padded (see {@link padForDeflate}) so the archive genuinely
 * exercises `unzip -p`'s decompression path rather than passing via stored (uncompressed) bytes.
 * Test-fixture generation only: production code (`artifact-inspect.ts`) only ever *reads* archives
 * (`unzip -p`), never writes them. */
export const buildZipFixture = async (zipPath: string, entries: FixtureEntries): Promise<void> => {
  const stagingDir = await mkdtemp(path.join(tmpdir(), "cordierite-fixture-src-"));

  try {
    await writeEntries(stagingDir, entries);

    const result = spawnSync("zip", ["-q", "-r", zipPath, "."], { cwd: stagingDir });

    if (result.status !== 0) {
      throw new Error(
        `Fixture setup: "zip" failed building ${zipPath}: ${result.stderr?.toString("utf8") ?? result.status}`,
      );
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
};

/** Builds an unpacked `.app` bundle directory (the non-zipped simulator/macOS artifact shape). */
export const buildAppDirectoryFixture = async (appDirPath: string, entries: FixtureEntries): Promise<void> => {
  await mkdir(appDirPath, { recursive: true });
  await writeEntries(appDirPath, entries);
};

export const makeFixtureRoot = async (): Promise<string> => {
  return mkdtemp(path.join(tmpdir(), "cordierite-doctor-fixtures-"));
};
