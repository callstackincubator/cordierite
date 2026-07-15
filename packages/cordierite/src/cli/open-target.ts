/**
 * Emulator/simulator fast path (ARCHITECTURE.md §8 delivery path 1, §10 `link --open`): delivers a
 * deep link to a booted Android emulator/device or iOS simulator without any human handling a QR
 * code — this is the CI/agent path. All subprocess execution goes through the injectable
 * {@link ExecFn} seam so every branch here is testable without `adb`/`xcrun` installed.
 */

import { execFile } from "node:child_process";

import { connectionError, usageError } from "../errors.js";

export type OpenTarget = "android" | "ios-sim";

export const isOpenTarget = (value: string): value is OpenTarget => {
  return value === "android" || value === "ios-sim";
};

export type ExecResult = {
  stdout: string;
  stderr: string;
};

/** Injectable process-execution seam; tests stub this instead of shelling out to `adb`/`xcrun`. */
export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

/** Real subprocess execution via `execFile` (no shell involved — argv is passed verbatim). */
export const defaultExec: ExecFn = (command, args) => {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
};

const TOOL_INSTALL_HINT: Record<string, string> = {
  adb: "the Android platform-tools (adb)",
  xcrun: "the Xcode command line tools (xcrun)",
};

const run = async (exec: ExecFn, command: string, args: string[]): Promise<ExecResult> => {
  try {
    return await exec(command, args);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };

    if (err.code === "ENOENT") {
      throw connectionError(
        `"${command}" was not found on PATH. Install ${TOOL_INSTALL_HINT[command] ?? command} and retry.`,
      );
    }

    const stderr = (err.stderr ?? "").trim();
    throw connectionError(
      `"${command} ${args.join(" ")}" failed${stderr ? `: ${stderr}` : `: ${err.message}`}`,
    );
  }
};

// --- ios-sim ---

type SimctlDeviceListing = {
  devices?: Record<string, Array<{ state?: string }>>;
};

const hasBootedSimulator = (stdout: string): boolean => {
  let parsed: SimctlDeviceListing;

  try {
    parsed = JSON.parse(stdout) as SimctlDeviceListing;
  } catch {
    return false;
  }

  return Object.values(parsed.devices ?? {}).some((entries) =>
    entries.some((entry) => entry.state === "Booted"),
  );
};

const deliverIosSim = async (exec: ExecFn, deepLink: string): Promise<void> => {
  const preflight = await run(exec, "xcrun", ["simctl", "list", "devices", "booted", "--json"]);

  if (!hasBootedSimulator(preflight.stdout)) {
    throw usageError("No booted iOS simulator found. Boot a simulator (e.g. via Xcode) and retry.");
  }

  await run(exec, "xcrun", ["simctl", "openurl", "booted", deepLink]);
};

// --- android ---

type AdbDeviceEntry = { serial: string; state: string };

/** Parses `adb devices` output: header line, then `<serial>\t<state>` per attached device. */
const parseAdbDevices = (stdout: string): AdbDeviceEntry[] => {
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [serial = "", state = ""] = line.split(/\s+/u);
      return { serial, state };
    })
    .filter((entry) => entry.serial.length > 0);
};

/**
 * Resolves the `-s <serial>` argument, if any. `--device` always wins; otherwise, if
 * `ANDROID_SERIAL` is set, `adb` already honors it with no flag needed from us; otherwise exactly
 * one attached device is required (zero or several is an error naming what's attached).
 */
const resolveAndroidSerial = async (
  exec: ExecFn,
  device: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  if (device) {
    return device;
  }

  if (env.ANDROID_SERIAL) {
    return undefined;
  }

  const listing = await run(exec, "adb", ["devices"]);
  const attached = parseAdbDevices(listing.stdout).filter((entry) => entry.state === "device");

  if (attached.length === 0) {
    throw usageError('No Android device or emulator is attached ("adb devices" listed none).');
  }

  if (attached.length > 1) {
    throw usageError(
      `Multiple Android devices are attached (${attached
        .map((entry) => entry.serial)
        .join(", ")}); specify --device <serial> or set ANDROID_SERIAL.`,
    );
  }

  return undefined;
};

const withSerial = (args: string[], serial: string | undefined): string[] => {
  return serial ? ["-s", serial, ...args] : args;
};

const deliverAndroid = async (
  exec: ExecFn,
  deepLink: string,
  wssPort: number,
  device: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  const serial = await resolveAndroidSerial(exec, device, env);

  // `adb reverse` before `am start`: the port forward must exist before the app tries to connect,
  // which can happen the instant the deep link is handled.
  await run(exec, "adb", withSerial(["reverse", `tcp:${wssPort}`, `tcp:${wssPort}`], serial));

  await run(
    exec,
    "adb",
    withSerial(
      [
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        // `adb shell` reconstructs everything after "shell" into one string and re-parses it on the
        // device's own shell; single-quoting the URL here (not just for local execFile, which never
        // re-tokenizes argv) protects against that second, remote parse (ARCHITECTURE.md §8).
        `'${deepLink}'`,
      ],
      serial,
    ),
  );
};

export type OpenTargetOptions = {
  target: OpenTarget;
  /** The composed `<scheme>:///?cordierite=<payload>` deep link to deliver. */
  deepLink: string;
  /** The daemon's wss port; used for `adb reverse tcp:<port> tcp:<port>`. */
  wssPort: number;
  /** `--device <serial>`; android-only. */
  device?: string;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
};

/** Delivers `deepLink` to a booted Android device/emulator or iOS simulator. Throws a clear,
 * actionable error (missing tool, no booted device, ambiguous device) rather than a raw one. */
export const deliverToOpenTarget = async (options: OpenTargetOptions): Promise<void> => {
  const exec = options.exec ?? defaultExec;

  if (options.target === "ios-sim") {
    await deliverIosSim(exec, options.deepLink);
    return;
  }

  await deliverAndroid(exec, options.deepLink, options.wssPort, options.device, options.env ?? process.env);
};
