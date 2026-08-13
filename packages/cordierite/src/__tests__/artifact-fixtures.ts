/**
 * Test-only fixture builders for `artifact-inspect.test.ts`/`doctor.test.ts`. These are
 * **synthetic** artifacts — plain files with marker strings dropped into a real zip container via
 * the `zip` CLI, not actual Xcode/Gradle build output. That's a deliberate scope choice for this
 * sandboxed environment (no Xcode/Android SDK toolchain to produce a real signed `.ipa`/`.apk`
 * here): `inspectArtifact` never parses Mach-O load commands, dex bytecode, or binary-plist/AXML
 * structure — it does a raw byte-substring scan over decompressed archive contents (see
 * `artifact-inspect.ts`'s doc comment) — so a synthetic archive with the right bytes in the right
 * *container* shape (a real zip, a real `.app` directory) exercises the exact same code path a real
 * build artifact would. What it does **not** exercise is whether a real Xcode/Gradle release build
 * actually produces those marker bytes in the first place (e.g. Android R8 renaming symbols) — see
 * `artifact-inspect.ts`'s doc comment and the task report for that caveat.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type FixtureEntries = Record<string, string | Buffer>;

const writeEntries = async (rootDir: string, entries: FixtureEntries): Promise<void> => {
  for (const [relativePath, contents] of Object.entries(entries)) {
    const filePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
};

/** Builds a real zip archive at `zipPath` from a flat map of relative path -> file contents, via
 * the `zip` CLI. Test-fixture generation only: production code (`artifact-inspect.ts`) only ever
 * *reads* archives (`unzip -p`), never writes them. */
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
