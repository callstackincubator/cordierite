/**
 * Emulator/simulator fast path (ARCHITECTURE.md §8 delivery path 1, §10 `link --open`): delivers a
 * deep link to a booted Android emulator/device or iOS simulator without any human handling a QR
 * code — this is the CI/agent path. All subprocess execution goes through the injectable
 * {@link ExecFn} seam so every branch here is testable without `adb`/`xcrun` installed.
 *
 * {@link detectBootedTargets} is the same enumeration used *before* a target is chosen, so callers
 * that were given no explicit target (notably `cordierite_connect` over MCP) can deliver to the one
 * obvious device instead of falling back to a QR code nobody is there to scan.
 *
 * A third, experimental target — `ios-device`, a paired physical iPhone/iPad via `xcrun devicectl`
 * (issue #31) — is explicit opt-in only: it is never auto-detected, it needs the app's bundle id,
 * and its link must carry the LAN address rather than `127.0.0.1` (see {@link usesLoopbackAddress}).
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectionError, usageError } from "../errors.js";

export type OpenTarget = "android" | "ios-sim" | "ios-device";

export const isOpenTarget = (value: string): value is OpenTarget => {
  return value === "android" || value === "ios-sim" || value === "ios-device";
};

/** Human-readable list of every accepted target, for the "must be one of" validation messages the
 * CLI, the shared `mintLink` core and `cordierite_connect` each render in their own wording. */
export const OPEN_TARGETS: readonly OpenTarget[] = ["android", "ios-sim", "ios-device"];

/**
 * Whether a link delivered to this target reaches the daemon over loopback, and so must be minted
 * with the `127.0.0.1` address override (`link.ts`, `mcp/connect-tool.ts`). True for `android`
 * (`adb reverse` forwards the port onto the device) and `ios-sim` (the simulator shares the host's
 * network stack); false for `ios-device` — a physical iPhone reaches the daemon only over the LAN,
 * so such a link must carry the machine's real advertised address (issue #31).
 */
export const usesLoopbackAddress = (target: OpenTarget): boolean => {
  return target === "android" || target === "ios-sim";
};

/**
 * Whether an advertised address is one that only resolves back to the machine that minted the link.
 * `daemon/address.ts` falls back to `127.0.0.1` when it cannot find a routable interface, and such
 * a link handed to a physical phone points the phone at *itself*: the app connects to nothing, the
 * session is never claimed, and `wait_for_session` blocks for its whole timeout with no clue why.
 * The `ios-device` path checks this after minting and refuses rather than delivering.
 */
export const isLoopbackAddress = (address: string): boolean => {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/gu, "");

  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    /^127\./u.test(normalized)
  );
};

/** The one wording for that refusal, shared by the CLI and MCP paths. */
export const loopbackAddressMessage = (address: string): string =>
  `The daemon advertised "${address}", which a physical device cannot reach — it would point the ` +
  "phone at itself and the session would never be claimed. No routable LAN address was detected; " +
  'set "advertisedIp" in config.json to this machine\'s address on the network the device is on, ' +
  "and retry.";

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

// --- ios-device (experimental, issue #31) ---

/**
 * `devicectl` writes its JSON to a *file* (`--json-output <path>`), never to stdout, so this path
 * cannot reuse the stdout-parsing shape `simctl` uses. The file lives in a private `mkdtemp`
 * directory removed in a `finally`, so a failing `devicectl` (or a malformed payload) never leaks
 * a temp file.
 */
const runDevicectlJson = async (
  exec: ExecFn,
  buildArgs: (file: string) => string[],
): Promise<unknown> => {
  let dir: string;

  try {
    dir = await mkdtemp(path.join(tmpdir(), "cordierite-devicectl-"));
  } catch (error) {
    // A read-only or missing TMPDIR would otherwise surface as a bare `EACCES`/`ENOENT` against a
    // path the user never chose, with nothing saying which knob to turn.
    throw connectionError(
      `A temporary directory for devicectl's --json-output could not be created in "${tmpdir()}" ` +
        `(${(error as Error).message}). Set TMPDIR to a writable directory and retry.`,
    );
  }

  const file = path.join(dir, "devicectl.json");

  try {
    await run(exec, "xcrun", buildArgs(file));

    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      // `devicectl` exited 0 but wrote nothing readable. Treated as an empty listing (the caller
      // renders "no device found") rather than surfacing a JSON syntax error, matching how
      // `parseBootedSimulators` handles unparseable `simctl` output.
      return undefined;
    }
  } finally {
    // Swallowed deliberately: a failure to clean up a temp directory must not replace the
    // devicectl error the caller actually needs to read (a `finally` that throws wins).
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
};

type DevicectlDeviceEntry = {
  identifier?: string;
  connectionProperties?: { pairingState?: string; tunnelState?: string };
  deviceProperties?: { name?: string };
  hardwareProperties?: { udid?: string; platform?: string };
};

type DevicectlDeviceListing = {
  result?: { devices?: DevicectlDeviceEntry[] };
};

export type PairedIosDevice = { udid: string; name: string };

/** `hardwareProperties.platform` values `devicectl` reports for things that are not an iPhone or
 * iPad. A paired Apple Watch or Vision Pro is a real CoreDevice and shows up in the same listing,
 * but cannot run the app and must never make the device choice look ambiguous. */
const DELIVERABLE_PLATFORM = "ios";

/**
 * The only `tunnelState` that means "not reachable at all". Deliberately *not* including
 * `disconnected`: a wired, trusted iPhone routinely reports `disconnected` (the tunnel is brought
 * up on demand), so excluding it would drop exactly the device this target exists to reach. This
 * matches the vendored Expo CLI's own `devicectl` integration
 * (`@expo/cli`'s `AppleDevice.js:102`), which keeps `disconnected` and excludes only `unavailable`.
 */
const UNREACHABLE_TUNNEL_STATE = "unavailable";

/** Expo's companion condition: a usable device is affirmatively `paired`. */
const USABLE_PAIRING_STATE = "paired";

/**
 * `devicectl list devices` lists **every CoreDevice the Mac has ever known**, across platforms and
 * regardless of whether it is plugged in — so the listing has to be filtered, not trusted.
 *
 * Filtering happens here rather than through `devicectl --filter` (an NSPredicate over undocumented
 * keys) so that every rule is exercised by the `ExecFn` tests instead of by a predicate string no
 * test can evaluate.
 *
 * Each rule drops an entry only when the field is **present and disqualifying**; a missing field
 * keeps the device. The field names are undocumented, so a `devicectl` that stops emitting one must
 * degrade to "offer the device and let the launch fail loudly", never to "silently find nothing".
 * That is the one deliberate departure from Expo, which tests `pairingState === "paired"`
 * positively and so would find nothing at all if the key were ever renamed.
 */
const parsePairedIosDevices = (payload: unknown): PairedIosDevice[] => {
  const devices = (payload as DevicectlDeviceListing | undefined)?.result?.devices;

  if (!Array.isArray(devices)) {
    return [];
  }

  return devices
    .map((entry) => {
      const platform = entry?.hardwareProperties?.platform;

      if (typeof platform === "string" && platform.toLowerCase() !== DELIVERABLE_PLATFORM) {
        return undefined;
      }

      const tunnelState = entry?.connectionProperties?.tunnelState;

      if (typeof tunnelState === "string" && tunnelState.toLowerCase() === UNREACHABLE_TUNNEL_STATE) {
        return undefined;
      }

      const pairingState = entry?.connectionProperties?.pairingState;

      if (typeof pairingState === "string" && pairingState.toLowerCase() !== USABLE_PAIRING_STATE) {
        return undefined;
      }

      // `hardwareProperties.udid` is what `--device` wants; `identifier` (the CoreDevice UUID) is
      // also accepted by `devicectl`, so a listing that omits the udid is still usable rather than
      // silently dropped. Checked for emptiness rather than `??`, which would keep a `""` udid and
      // never reach the documented fallback.
      const hardwareUdid = entry?.hardwareProperties?.udid;
      const udid =
        typeof hardwareUdid === "string" && hardwareUdid.length > 0
          ? hardwareUdid
          : entry?.identifier;

      return typeof udid === "string" && udid.length > 0
        ? { udid, name: entry?.deviceProperties?.name ?? udid }
        : undefined;
    })
    .filter((device): device is PairedIosDevice => device !== undefined);
};

const listPairedIosDevices = async (exec: ExecFn): Promise<PairedIosDevice[]> => {
  const payload = await runDevicectlJson(exec, (file) => [
    "devicectl",
    "list",
    "devices",
    "--timeout",
    "5",
    "--json-output",
    file,
  ]);

  return parsePairedIosDevices(payload);
};

const describeIosDevice = (device: PairedIosDevice): string => `${device.name} (${device.udid})`;

/** The single wording naming both ways to supply a bundle id, so the CLI and MCP paths agree. */
export const MISSING_BUNDLE_ID_MESSAGE =
  "Delivering to a physical iPhone needs the app's bundle id: pass \"--bundle-id <id>\" (or " +
  '"bundleId" over MCP), or set "iosBundleId" in config.json.';

/**
 * A bundle id is the **only trailing positional** in the `devicectl device process launch` argv, so
 * a value beginning with `-` would be read by `devicectl` as an option rather than as the app to
 * launch — `--console`, say, silently changing what the command does. Apple's own grammar for a
 * bundle identifier is alphanumerics, `.` and `-`, which never legitimately starts with `-`, so
 * enforcing exactly that shape closes the hole at every entry point.
 *
 * A `--` terminator is deliberately *not* used instead: `devicectl` takes launch arguments after
 * the bundle id, its handling of `--` is undocumented, and none of it can be verified without
 * hardware — whereas this check is exact and fully testable.
 */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/u;

export const isValidBundleId = (value: string): boolean => BUNDLE_ID_PATTERN.test(value);

export const invalidBundleIdMessage = (value: string): string =>
  `"${value}" is not a valid iOS bundle id (letters, digits, "." and "-", starting with a letter ` +
  "or digit).";

/** Same ambiguity rules as `deliverIosSim`: exactly one paired device, or the caller names one. */
const resolveSingleIosDevice = async (exec: ExecFn): Promise<string> => {
  const paired = await listPairedIosDevices(exec);

  if (paired.length === 0) {
    throw usageError(
      'No connected iOS device was found ("xcrun devicectl list devices" listed none, ignoring ' +
        "disconnected devices and non-iOS ones such as a paired Watch or Vision Pro). Connect the " +
        "device, trust this Mac, and enable Developer Mode on it, then retry.",
    );
  }

  if (paired.length > 1) {
    throw usageError(
      `Multiple connected iOS devices were found (${paired
        .map(describeIosDevice)
        .join(", ")}); specify --device <udid>.`,
    );
  }

  return paired[0]!.udid;
};

/**
 * Experimental physical-iPhone delivery (issue #31). `xcrun devicectl device process launch
 * --device <udid> --payload-url <url> <bundle-id>` is undocumented by Apple but is the mechanism
 * Xcode 15+ exposes for handing a URL to an installed, dev-signed app on a paired iOS 17+ device.
 * It may cold-launch (rather than foreground) the app; the app side copes either way, because a
 * delivered link supersedes a held session and the initial-URL path is handled.
 *
 * Unlike `ios-sim`, this is never auto-detected — see {@link detectBootedTargets}.
 */
const deliverIosDevice = async (
  exec: ExecFn,
  deepLink: string,
  device: string | undefined,
  bundleId: string | undefined,
  relaunch: boolean,
): Promise<void> => {
  // Checked before any enumeration: without a bundle id the launch cannot happen at all, so
  // spending a `devicectl list devices` timeout first would only delay the same error.
  if (!bundleId) {
    throw usageError(MISSING_BUNDLE_ID_MESSAGE);
  }

  // Last line of defence: every caller validates too, but this is the one place the value reaches
  // an argv, so it is the one place that must not be bypassable.
  if (!isValidBundleId(bundleId)) {
    throw usageError(invalidBundleIdMessage(bundleId));
  }

  // An explicit udid is honored without a preflight, mirroring the `ios-sim`/`android` passthrough.
  const udid = device ?? (await resolveSingleIosDevice(exec));

  await run(exec, "xcrun", [
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    udid,
    // Opt-in only (`--relaunch` / `relaunch: true`). A plain `process launch` is what the vendored
    // Expo CLI does, so it is the better-attested default; what it does when the app is *already
    // running* is the one thing nobody here can verify without hardware. If that turns out to fail
    // rather than deliver the URL, `--terminate-existing` is the escape hatch — it kills the
    // running instance first, which Cordierite copes with because a delivered link supersedes a
    // held session.
    ...(relaunch ? ["--terminate-existing"] : []),
    "--payload-url",
    deepLink,
    bundleId,
  ]);
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
 *
 * Physical iPhones (`ios-device`) are deliberately *not* enumerated here (issue #31): a paired
 * iPhone is often someone's personal phone rather than a test device, delivery to it may
 * cold-launch the app, and it additionally needs a bundle id the caller has to supply. It is an
 * explicit, opt-in target only.
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
  /** An adb device serial (`target: "android"`), a simulator udid (`target: "ios-sim"`) or a
   * paired-device udid (`target: "ios-device"`). */
  device?: string;
  /** The installed app's bundle id. Required by (and only used for) `target: "ios-device"`. */
  bundleId?: string;
  /** `target: "ios-device"` only: terminate a running instance first (`--terminate-existing`)
   * instead of launching over it. Off by default; see {@link deliverToOpenTarget}. */
  relaunch?: boolean;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
};

/** Delivers `deepLink` to a booted Android device/emulator, an iOS simulator, or (experimentally)
 * a paired physical iOS device. Throws a clear, actionable error (missing tool, no booted device,
 * ambiguous device, missing bundle id) rather than a raw one. */
export const deliverToOpenTarget = async (options: OpenTargetOptions): Promise<void> => {
  const exec = options.exec ?? defaultExec;

  if (options.target === "ios-sim") {
    await deliverIosSim(exec, options.deepLink, options.device);
    return;
  }

  if (options.target === "ios-device") {
    await deliverIosDevice(
      exec,
      options.deepLink,
      options.device,
      options.bundleId,
      options.relaunch ?? false,
    );
    return;
  }

  await deliverAndroid(exec, options.deepLink, options.wssPort, options.device, options.env ?? process.env);
};
