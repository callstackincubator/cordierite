/**
 * `cordierite doctor` (docs/tasks/08-cordierite-doctor.md): the artifact-level replacement for the
 * runtime `debuggable`/`#if DEBUG` gate removed elsewhere in opt-in hardening. Given a built
 * `.app`/`.ipa`/`.apk`/`.aab`, decide whether Cordierite's native code actually shipped inside it —
 * not whether the config that's supposed to have produced it looks right.
 *
 * The one property everything here is built around: **never report "absent" because a tool was
 * missing or the artifact couldn't be read.** That failure mode is strictly worse than not having
 * this check at all, because it turns a release gate into a rubber stamp that always exits 0 once
 * `unzip` happens to be missing from a runner's image. Every path that can't produce a truthful
 * answer throws {@link inspectionError} — a distinct, non-zero exit — instead of falling through to
 * `present: false`.
 *
 * Detection strategy, and why it's two signals per platform rather than one:
 *
 * - iOS: the Objective-C class name `RCTNativeCordierite` (`RCT_EXPORT_MODULE`, see
 *   `packages/react-native/ios/RCTNativeCordierite.mm`) is Objective-C runtime metadata — it lives
 *   in `__objc_classname`/`__objc_data`, and `strip`/release optimization leaves it alone because
 *   removing it would break `+[NSObject class]`-based dispatch. (A build that dead-strips the whole
 *   translation unit for lack of `-ObjC`/`-force_load` could still drop it — this signal assumes
 *   the module actually links into the binary, which is the thing being checked in the first
 *   place.) It's corroborated by the plugin-authored `Info.plist` keys
 *   (`CordieriteCliPins`/`CordieriteTrust`/`CordieriteAllowPrivateLanOnly`, docs/tasks/00-overview.md
 *   "Native config keys the plugin writes"), which are plist string data, not code, so they can't be
 *   renamed by anything that mangles symbols.
 * - Android: the primary signal is `CordieriteNativeMarker`
 *   (`packages/react-native/android/src/main/java/com/callstackincubator/cordierite/CordieriteNativeMarker.kt`),
 *   a marker class with no other purpose. Its fully-qualified name is kept unminified and unremoved by a
 *   `-keep` rule in `packages/react-native/android/consumer-rules.pro`, shipped to every consuming app via
 *   `consumerProguardFiles` (see `../build.gradle`) — R8 applies it regardless of whether the app used the
 *   Expo config plugin or bare-RN autolinking, and regardless of whether the app authored any keep rules of
 *   its own (docs/tasks/10-android-detection-keep-rule.md). This is the only Android signal guaranteed to
 *   survive minification in every supported consumer setup.
 *
 *   Two more signals are kept as fallbacks for artifacts built before this marker existed: the
 *   `com.callstackincubator.cordierite` package string in the dex string pool (survives as long as
 *   R8/ProGuard minification+obfuscation isn't applied to it — an aggressive release config with no keep
 *   rule for this package can rename it away) and the plugin-authored meta-data key names in
 *   `AndroidManifest.xml` (`com.callstackincubator.cordierite.CLI_PINS`/`TRUST`/`ALLOW_PRIVATE_LAN_ONLY`):
 *   those are XML attribute string values written by the config plugin at prebuild time, not compiled
 *   identifiers, so R8 never touches them, but they only exist at all if the config plugin ran. Both
 *   encodings AAPT2 can choose for the manifest string pool (UTF-8 or UTF-16LE) are checked.
 *
 * No single signal is treated as authoritative on its own for "absent": presence is an OR across all
 * signals for a platform, specifically so a minified dex that dropped one literal doesn't flip a real
 * inclusion to "absent" just because one check missed.
 *
 * `cordierite doctor` is strictly better than the runtime check it replaces (docs/tasks/00-overview.md
 * "What we give up, deliberately"). The keep-rule marker closes the previously-documented gap where a
 * bare-RN app with no config plugin and no keep rule could evade both older Android signals under R8
 * minification (docs/tasks/10-android-detection-keep-rule.md) — that gap applied to builds produced before
 * this library shipped the marker/keep rule; an app that pins an older `@cordierite/react-native` version
 * still lacks it.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { inspectionError, usageError } from "./errors.js";

export type ArtifactPlatform = "ios" | "android";
export type ArtifactFormat = "app" | "ipa" | "apk" | "aab";

export type DetectionSignal =
  | "ios-objc-class-symbol"
  | "ios-info-plist-keys"
  | "android-keep-rule-marker"
  | "android-dex-package-symbol"
  | "android-manifest-meta-data-keys";

export type ArtifactInspection = {
  platform: ArtifactPlatform;
  format: ArtifactFormat;
  present: boolean;
  /** Which specific markers matched — empty when `present` is `false`. Surfaced for auditability,
   * not just a boolean: a report that says *why* is checkable by a human without re-running the
   * tool with more verbosity. */
  signals: DetectionSignal[];
};

// --- markers ---

const IOS_OBJC_CLASS_MARKER = "RCTNativeCordierite";
const IOS_INFO_PLIST_KEY_MARKERS = ["CordieriteCliPins", "CordieriteTrust", "CordieriteAllowPrivateLanOnly"];

// Fully-qualified name of `CordieriteNativeMarker`
// (packages/react-native/android/src/main/java/com/callstackincubator/cordierite/CordieriteNativeMarker.kt),
// kept unminified by packages/react-native/android/consumer-rules.pro. Checked as a dex type descriptor
// (`Lcom/.../CordieriteNativeMarker;`) — see detectAndroidSignals — which is how the class's fully-qualified
// name is actually encoded in classes.dex.
const ANDROID_KEEP_RULE_MARKER_CLASS = "com/callstackincubator/cordierite/CordieriteNativeMarker";

const ANDROID_DEX_PACKAGE_MARKERS = ["com/callstackincubator/cordierite", "com.callstackincubator.cordierite"];
const ANDROID_MANIFEST_KEY_MARKER = "com.callstackincubator.cordierite.";

const bufferIncludesAscii = (haystack: Buffer, needle: string): boolean => {
  return haystack.includes(Buffer.from(needle, "utf8"));
};

const bufferIncludesUtf16le = (haystack: Buffer, needle: string): boolean => {
  return haystack.includes(Buffer.from(needle, "utf16le"));
};

// --- process execution seam (mirrors src/cli/open-target.ts's ExecFn, but with Buffer stdout:
// archive contents are binary and must not round-trip through a lossy utf8 string conversion) ---

export type ExecBufferResult = {
  stdout: Buffer;
  stderr: Buffer;
};

/** Injectable subprocess seam; tests stub this to simulate a missing `unzip` (ENOENT) or a
 * corrupt-archive failure without needing either condition to be true on the machine running the
 * tests. */
export type ExecBufferFn = (command: string, args: string[]) => Promise<ExecBufferResult>;

/** Real subprocess execution via `execFile`, buffered as raw bytes. `maxBuffer` is generous (an
 * artifact's full decompressed contents are read into memory at once — see {@link readZipEntries})
 * since real `.ipa`/`.apk`/`.aab` files can run into the hundreds of MB. */
export const defaultExecBuffer: ExecBufferFn = (command, args) => {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
};

const TOOL_INSTALL_HINT: Record<string, string> = {
  unzip: "Info-ZIP's unzip (present by default on macOS and most Linux CI images)",
};

/** Runs an external tool, translating "not found on PATH" and "ran but failed" into a single
 * {@link inspectionError} class — both mean the same thing to a caller: this artifact could not be
 * inspected, so no presence/absence claim can be trusted. Never resolves to a result that looks
 * like a clean "not present" answer. */
const runToolOrInspectionError = async (
  exec: ExecBufferFn,
  command: string,
  args: string[],
  context: string,
): Promise<Buffer> => {
  try {
    const result = await exec(command, args);
    return result.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer };

    if (err.code === "ENOENT") {
      throw inspectionError(
        `"${command}" was not found on PATH; cannot inspect ${context}. Install ${
          TOOL_INSTALL_HINT[command] ?? command
        } and retry.`,
      );
    }

    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw inspectionError(
        `"${command} ${args.join(" ")}" produced more output than this command will buffer while ` +
          `inspecting ${context}. The artifact is unusually large, not necessarily corrupt — this is ` +
          `a tooling limit, not a presence/absence answer.`,
      );
    }

    const stderr = err.stderr ? err.stderr.toString("utf8").trim() : "";
    throw inspectionError(
      `"${command} ${args.join(" ")}" failed while inspecting ${context}${
        stderr ? `: ${stderr}` : `: ${err.message}`
      }. The artifact may be corrupt or not a valid archive.`,
    );
  }
};

/** The container-shape check every zip-format artifact must pass before its contents are trusted
 * for a presence/absence answer (see {@link readZipEntries}): an empty, wrong-file-renamed, or
 * otherwise not-actually-that-kind-of-artifact zip must never silently read back as "no signals
 * found" — it isn't an answer, it's evidence the input wasn't what its extension claimed. */
const EXPECTED_ENTRY_PATTERN: Record<"ipa" | "apk" | "aab", RegExp> = {
  ipa: /\.app\//iu,
  apk: /(^|\/)AndroidManifest\.xml$/u,
  aab: /(^|\/)AndroidManifest\.xml$/u,
};

const assertExpectedZipShape = (
  format: "ipa" | "apk" | "aab",
  entries: string[],
  context: string,
): void => {
  if (entries.length === 0) {
    throw inspectionError(`${context} contains no entries — it is not a valid archive.`);
  }

  if (!entries.some((entry) => EXPECTED_ENTRY_PATTERN[format].test(entry))) {
    throw inspectionError(
      `${context} does not look like a valid .${format}: none of its ${entries.length} entries match ` +
        `the expected ${format === "ipa" ? '"*.app/" bundle' : '"AndroidManifest.xml"'} shape. Refusing ` +
        `to report absence for an artifact that may simply be the wrong file.`,
    );
  }
};

/** Lists a zip archive's entry names via `unzip -Z1` (zipinfo mode: one path per line, nothing
 * else) — used only for the {@link assertExpectedZipShape} sanity check, not for detection itself. */
const listZipEntries = async (exec: ExecBufferFn, archivePath: string, context: string): Promise<string[]> => {
  const stdout = await runToolOrInspectionError(exec, "unzip", ["-Z1", archivePath], context);

  return stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

/** Streams every entry of a zip-format archive (`.ipa`/`.apk`/`.aab` are all zip containers)
 * decompressed and concatenated to one buffer, via `unzip -p`. Deliberately does not attempt to
 * enumerate entries and extract selectively first — a single whole-archive pass is simpler, cannot
 * miss a signal hiding in an unexpected internal path (embedded framework, AAB's `base/dex/`
 * nesting, ...), and correctness matters far more than the marginal speed of a narrower read for a
 * command that runs once per release. Validates the archive actually has the expected internal
 * shape first ({@link assertExpectedZipShape}) so an empty or mislabeled zip can't read back as a
 * clean "no signals found" instead of the "this wasn't a real artifact" it actually is. */
const readZipEntries = async (
  exec: ExecBufferFn,
  archivePath: string,
  format: "ipa" | "apk" | "aab",
  context: string,
): Promise<Buffer> => {
  const entries = await listZipEntries(exec, archivePath, context);
  assertExpectedZipShape(format, entries, context);

  return runToolOrInspectionError(exec, "unzip", ["-p", archivePath], context);
};

/** Recursively reads every regular file under a `.app` bundle directory into one concatenated
 * buffer. Symlinks are skipped (never followed) to avoid loops; `.app` bundles don't legitimately
 * need them for this check. */
const readAppDirectory = async (appDirPath: string, context: string): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw inspectionError(
        `Could not read "${dir}" while inspecting ${context}: ${(error as Error).message}.`,
      );
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (entry.isFile()) {
        try {
          chunks.push(await readFile(entryPath));
        } catch (error) {
          throw inspectionError(
            `Could not read "${entryPath}" while inspecting ${context}: ${(error as Error).message}.`,
          );
        }
      }
    }
  };

  await walk(appDirPath);
  return Buffer.concat(chunks);
};

// --- format resolution ---

const resolveFormat = (artifactPath: string): { platform: ArtifactPlatform; format: ArtifactFormat } => {
  const extension = path.extname(artifactPath).toLowerCase();

  switch (extension) {
    case ".app":
      return { platform: "ios", format: "app" };
    case ".ipa":
      return { platform: "ios", format: "ipa" };
    case ".apk":
      return { platform: "android", format: "apk" };
    case ".aab":
      return { platform: "android", format: "aab" };
    default:
      throw usageError(
        `Unrecognized artifact extension "${extension || artifactPath}". Expected one of: .app, .ipa, .apk, .aab.`,
      );
  }
};

// --- signal detection ---

const detectIosSignals = (bytes: Buffer): DetectionSignal[] => {
  const signals: DetectionSignal[] = [];

  if (bufferIncludesAscii(bytes, IOS_OBJC_CLASS_MARKER)) {
    signals.push("ios-objc-class-symbol");
  }

  if (IOS_INFO_PLIST_KEY_MARKERS.some((marker) => bufferIncludesAscii(bytes, marker))) {
    signals.push("ios-info-plist-keys");
  }

  return signals;
};

const detectAndroidSignals = (bytes: Buffer): DetectionSignal[] => {
  const signals: DetectionSignal[] = [];

  // Primary signal: checked first because it's the only one guaranteed to survive R8 minification
  // in every supported consumer setup (see the file-level doc comment). Matched as a dex type
  // descriptor (`L` + fully-qualified-name-with-slashes + `;`) since that's the actual encoding of
  // a class name inside classes.dex, not just a loose substring check.
  if (bufferIncludesAscii(bytes, `L${ANDROID_KEEP_RULE_MARKER_CLASS};`)) {
    signals.push("android-keep-rule-marker");
  }

  if (ANDROID_DEX_PACKAGE_MARKERS.some((marker) => bufferIncludesAscii(bytes, marker))) {
    signals.push("android-dex-package-symbol");
  }

  if (
    bufferIncludesAscii(bytes, ANDROID_MANIFEST_KEY_MARKER) ||
    bufferIncludesUtf16le(bytes, ANDROID_MANIFEST_KEY_MARKER)
  ) {
    signals.push("android-manifest-meta-data-keys");
  }

  return signals;
};

// --- public entry point ---

export type InspectArtifactOptions = {
  exec?: ExecBufferFn;
};

/** Inspects a built artifact for Cordierite's native inclusion. Throws {@link usageError} for an
 * unrecognized path/extension (a CLI-usage mistake) and {@link inspectionError} for anything that
 * prevents a truthful presence/absence answer (missing tool, unreadable/corrupt artifact) — it
 * never resolves successfully with a guessed or default answer. */
export const inspectArtifact = async (
  artifactPath: string,
  options: InspectArtifactOptions = {},
): Promise<ArtifactInspection> => {
  const exec = options.exec ?? defaultExecBuffer;
  const { platform, format } = resolveFormat(artifactPath);
  const context = `"${artifactPath}"`;

  let stats;

  try {
    stats = await stat(artifactPath);
  } catch (error) {
    throw inspectionError(`Artifact not found at ${context}: ${(error as Error).message}.`);
  }

  let bytes: Buffer;

  if (format === "app") {
    if (!stats.isDirectory()) {
      throw inspectionError(`Expected ${context} (a ".app" bundle) to be a directory.`);
    }

    bytes = await readAppDirectory(artifactPath, context);
  } else {
    if (!stats.isFile()) {
      throw inspectionError(`Expected ${context} to be a file.`);
    }

    bytes = await readZipEntries(exec, artifactPath, format, context);
  }

  const signals = platform === "ios" ? detectIosSignals(bytes) : detectAndroidSignals(bytes);

  return {
    platform,
    format,
    present: signals.length > 0,
    signals,
  };
};
