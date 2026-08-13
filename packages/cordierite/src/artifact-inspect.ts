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
 *   in `__objc_classname`/`__objc_data` and can't be stripped by release optimization without
 *   breaking `+[NSObject class]`-based dispatch, so it survives exactly the kind of build this
 *   command exists to gate. It's corroborated by the plugin-authored `Info.plist` keys
 *   (`CordieriteCliPins`/`CordieriteTrust`/`CordieriteAllowPrivateLanOnly`, docs/tasks/00-overview.md
 *   "Native config keys the plugin writes"), which are plist string data, not code, so they can't be
 *   renamed by anything that mangles symbols.
 * - Android: the `com.callstackincubator.cordierite` package survives in the dex string pool as
 *   long as R8/ProGuard minification+obfuscation isn't applied to it. It *can* be renamed by an
 *   aggressive release config with no keep rule for this package — a real false-negative risk this
 *   command must not silently absorb into "absent". The corroborating signal is the same
 *   plugin-authored meta-data key names in `AndroidManifest.xml`
 *   (`com.callstackincubator.cordierite.CLI_PINS`/`TRUST`/`ALLOW_PRIVATE_LAN_ONLY`): those are XML
 *   attribute string values written by the config plugin at prebuild time, not compiled identifiers,
 *   so R8 never touches them. Presence is `true` if *either* signal matches; both encodings AAPT2
 *   can choose for the manifest string pool (UTF-8 or UTF-16LE) are checked.
 *
 * Neither corroborating signal is treated as authoritative on its own for "absent": presence is an
 * OR across all signals for a platform, specifically so a minified dex that dropped the package
 * name literal doesn't flip a real inclusion to "absent" just because one of the two checks missed.
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

    const stderr = err.stderr ? err.stderr.toString("utf8").trim() : "";
    throw inspectionError(
      `"${command} ${args.join(" ")}" failed while inspecting ${context}${
        stderr ? `: ${stderr}` : `: ${err.message}`
      }. The artifact may be corrupt or not a valid archive.`,
    );
  }
};

/** Streams every entry of a zip-format archive (`.ipa`/`.apk`/`.aab` are all zip containers)
 * decompressed and concatenated to one buffer, via `unzip -p`. Deliberately does not attempt to
 * enumerate entries and extract selectively first — a single whole-archive pass is simpler, cannot
 * miss a signal hiding in an unexpected internal path (embedded framework, AAB's `base/dex/`
 * nesting, ...), and correctness matters far more than the marginal speed of a narrower read for a
 * command that runs once per release. */
const readZipEntries = async (exec: ExecBufferFn, archivePath: string, context: string): Promise<Buffer> => {
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

    bytes = await readZipEntries(exec, artifactPath, context);
  }

  const signals = platform === "ios" ? detectIosSignals(bytes) : detectAndroidSignals(bytes);

  return {
    platform,
    format,
    present: signals.length > 0,
    signals,
  };
};
