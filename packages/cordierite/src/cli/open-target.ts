/**
 * Emulator/simulator fast path (ARCHITECTURE.md §8 delivery path 1, §10 `link --open`): delivers a
 * deep link to a booted Android emulator/device or iOS simulator without any human handling a QR
 * code — this is the CI/agent path. All subprocess execution goes through the injectable
 * {@link ExecFn} seam so every branch here is testable without `adb`/`xcrun` installed.
 *
 * {@link detectBootedTargets} is the same enumeration used *before* a target is chosen, so callers
 * that were given no explicit target (notably `cordierite_connect` over MCP) can deliver to the one
 * obvious device instead of falling back to a QR code nobody is there to scan.
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

type SimctlDeviceEntry = { udid?: string; name?: string; state?: string };

type SimctlDeviceListing = {
  devices?: Record<string, SimctlDeviceEntry[]>;
};

export type BootedSimulator = { udid: string; name: string };

const parseBootedSimulators = (stdout: string): BootedSimulator[] => {
  let parsed: SimctlDeviceListing;

  try {
    parsed = JSON.parse(stdout) as SimctlDeviceListing;
  } catch {
    return [];
  }

  return Object.values(parsed.devices ?? {})
    .flat()
    .filter(
      (entry): entry is SimctlDeviceEntry & { udid: string } =>
        entry.state === "Booted" && typeof entry.udid === "string" && entry.udid.length > 0,
    )
    .map((entry) => ({ udid: entry.udid, name: entry.name ?? entry.udid }));
};

const listBootedSimulators = async (exec: ExecFn): Promise<BootedSimulator[]> => {
  const preflight = await run(exec, "xcrun", ["simctl", "list", "devices", "booted", "--json"]);
  return parseBootedSimulators(preflight.stdout);
};

const describeSimulator = (simulator: BootedSimulator): string => `${simulator.name} (${simulator.udid})`;

const deliverIosSim = async (exec: ExecFn, deepLink: string, device: string | undefined): Promise<void> => {
  // An explicit udid is honored without a preflight, mirroring android's `--device` passthrough:
  // the caller has already named the device, so re-listing only adds a failure mode.
  if (device) {
    await run(exec, "xcrun", ["simctl", "openurl", device, deepLink]);
    return;
  }

  const booted = await listBootedSimulators(exec);

  if (booted.length === 0) {
    throw usageError("No booted iOS simulator found. Boot a simulator (e.g. via Xcode) and retry.");
  }

  if (booted.length > 1) {
    // Previously this delivered to simctl's `booted` alias regardless, which silently picks one of
    // several booted simulators — the link would land on an arbitrary device and the session would
    // never be claimed, looking exactly like a hung `wait_for_session`. Errors like android does.
    throw usageError(
      `Multiple iOS simulators are booted (${booted
        .map(describeSimulator)
        .join(", ")}); specify --device <udid>.`,
    );
  }

  // Target the resolved udid rather than the `booted` alias: `booted` is only unambiguous while
  // exactly one simulator is up, and a second one booting between the preflight and this call would
  // otherwise redirect the link to an arbitrary device.
  await run(exec, "xcrun", ["simctl", "openurl", booted[0]!.udid, deepLink]);
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

const listAttachedAndroidDevices = async (exec: ExecFn): Promise<string[]> => {
  const listing = await run(exec, "adb", ["devices"]);

  return parseAdbDevices(listing.stdout)
    .filter((entry) => entry.state === "device")
    .map((entry) => entry.serial);
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

  const attached = await listAttachedAndroidDevices(exec);

  if (attached.length === 0) {
    throw usageError('No Android device or emulator is attached ("adb devices" listed none).');
  }

  if (attached.length > 1) {
    throw usageError(
      `Multiple Android devices are attached (${attached.join(
        ", ",
      )}); specify --device <serial> or set ANDROID_SERIAL.`,
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

// --- detection ---

/** One device a link could be delivered to, resolved concretely enough to deliver without a
 * second, racy lookup: `device` is an adb serial or a simulator udid. */
export type DetectedTarget = {
  target: OpenTarget;
  device: string;
  /** Human-readable form for error messages and agent-facing notes. */
  label: string;
};

export type TargetDetection =
  | { kind: "single"; detected: DetectedTarget }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: DetectedTarget[] };

/** Best-effort enumeration: a missing or failing `xcrun`/`adb` means "no devices of that platform"
 * rather than an error. Detection runs when the caller named *no* target, so a machine without the
 * Android tools installed (or without Xcode) must still reach a clean `{ kind: "none" }` and its
 * QR fallback instead of failing the whole call. */
const safeList = async <T>(list: () => Promise<T[]>): Promise<T[]> => {
  try {
    return await list();
  } catch {
    return [];
  }
};

export type DetectBootedTargetsOptions = {
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
};

/**
 * Enumerates every booted simulator and attached Android device so a caller with no explicit
 * target can deliver to the single obvious one. `ANDROID_SERIAL`, when set, narrows the Android
 * side to that serial — it is exactly the disambiguation the user has already made.
 */
export const detectBootedTargets = async (
  options: DetectBootedTargetsOptions = {},
): Promise<TargetDetection> => {
  const exec = options.exec ?? defaultExec;
  const env = options.env ?? process.env;

  const [simulators, androidSerials] = await Promise.all([
    safeList(() => listBootedSimulators(exec)),
    env.ANDROID_SERIAL
      ? Promise.resolve([env.ANDROID_SERIAL])
      : safeList(() => listAttachedAndroidDevices(exec)),
  ]);

  const candidates: DetectedTarget[] = [
    ...simulators.map((simulator) => ({
      target: "ios-sim" as const,
      device: simulator.udid,
      label: describeSimulator(simulator),
    })),
    ...androidSerials.map((serial) => ({
      target: "android" as const,
      device: serial,
      label: serial,
    })),
  ];

  if (candidates.length === 0) {
    return { kind: "none" };
  }

  if (candidates.length === 1) {
    return { kind: "single", detected: candidates[0]! };
  }

  return { kind: "ambiguous", candidates };
};

export type OpenTargetOptions = {
  target: OpenTarget;
  /** The composed `<scheme>:///?cordierite=<payload>` deep link to deliver. */
  deepLink: string;
  /** The daemon's wss port; used for `adb reverse tcp:<port> tcp:<port>`. */
  wssPort: number;
  /** An adb device serial (`target: "android"`) or a simulator udid (`target: "ios-sim"`). */
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
    await deliverIosSim(exec, options.deepLink, options.device);
    return;
  }

  await deliverAndroid(exec, options.deepLink, options.wssPort, options.device, options.env ?? process.env);
};
