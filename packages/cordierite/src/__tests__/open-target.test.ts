/**
 * Unit tests for `cli/open-target.ts`, covering its acceptance matrix and all driven through the
 * injectable `ExecFn` seam — no real `adb`/`xcrun` process is ever spawned.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  deliverToOpenTarget,
  detectBootedTargets,
  isOpenTarget,
  usesLoopbackAddress,
  type ExecFn,
} from "../cli/open-target.js";

const DEEP_LINK = "playground:///?cordierite=abc123";
const BUNDLE_ID = "com.example.playground";

const bootedSimJson = JSON.stringify({
  devices: { "iOS 17.0": [{ state: "Booted", udid: "AAAA", name: "iPhone 15" }] },
});

const noBootedSimJson = JSON.stringify({
  devices: { "iOS 17.0": [{ state: "Shutdown", udid: "AAAA", name: "iPhone 15" }] },
});

const twoBootedSimsJson = JSON.stringify({
  devices: {
    "iOS 17.0": [
      { state: "Booted", udid: "AAAA", name: "iPhone 15" },
      { state: "Booted", udid: "BBBB", name: "iPad Pro" },
    ],
  },
});

/** `devicectl list devices --json-output <file>` writes to a *file*, so a stub `exec` has to
 * simulate that side effect rather than return stdout. Every ios-device stub goes through this. */
const devicectlExec = (
  calls: Array<{ command: string; args: string[] }>,
  listing: unknown,
  options: { failLaunch?: Error; failList?: Error } = {},
): ExecFn => {
  return async (command, args) => {
    calls.push({ command, args });

    const jsonOutputIndex = args.indexOf("--json-output");

    if (jsonOutputIndex !== -1) {
      if (options.failList) {
        throw options.failList;
      }

      const file = args[jsonOutputIndex + 1]!;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, typeof listing === "string" ? listing : JSON.stringify(listing), "utf8");
      return { stdout: "", stderr: "" };
    }

    if (options.failLaunch) {
      throw options.failLaunch;
    }

    return { stdout: "", stderr: "" };
  };
};

type DevicectlFixtureDevice = {
  udid?: string;
  identifier?: string;
  name?: string;
  /** Omitted entirely when `null`, so the "field absent ⇒ keep the device" rule is testable. */
  platform?: string | null;
  tunnelState?: string;
  pairingState?: string;
};

const devicectlListing = (devices: DevicectlFixtureDevice[]): unknown => ({
  info: { outcome: "success" },
  result: {
    devices: devices.map((device) => ({
      ...(device.identifier === undefined ? {} : { identifier: device.identifier }),
      deviceProperties: { name: device.name },
      connectionProperties: {
        ...(device.tunnelState === undefined ? {} : { tunnelState: device.tunnelState }),
        ...(device.pairingState === undefined ? {} : { pairingState: device.pairingState }),
      },
      hardwareProperties: {
        ...(device.udid === undefined ? {} : { udid: device.udid }),
        ...(device.platform === null ? {} : { platform: device.platform ?? "iOS" }),
      },
    })),
  },
});

/** The launch argv for a device, so the expectations stay in one place as the flags evolve. */
const launchArgs = (udid: string, deepLink: string, bundleId: string): string[] => [
  "devicectl",
  "device",
  "process",
  "launch",
  "--device",
  udid,
  "--terminate-existing",
  "--payload-url",
  deepLink,
  bundleId,
];

/** The directory `runDevicectlJson` creates and must remove; asserted gone after every call. */
const devicectlTempDirs = (calls: Array<{ command: string; args: string[] }>): string[] => {
  return calls
    .map((call) => {
      const index = call.args.indexOf("--json-output");
      return index === -1 ? undefined : path.dirname(call.args[index + 1]!);
    })
    .filter((dir): dir is string => dir !== undefined);
};

describe("isOpenTarget", () => {
  test("accepts android/ios-sim/ios-device, rejects anything else", () => {
    expect(isOpenTarget("android")).toBe(true);
    expect(isOpenTarget("ios-sim")).toBe(true);
    expect(isOpenTarget("ios-device")).toBe(true);
    expect(isOpenTarget("ios")).toBe(false);
    expect(isOpenTarget("iOS-Device")).toBe(false);
    expect(isOpenTarget("")).toBe(false);
  });
});

describe("usesLoopbackAddress", () => {
  test("android and ios-sim reach the daemon over loopback; a physical iPhone does not", () => {
    // The one decision that keeps `--open ios-device` usable at all: a `127.0.0.1` bootstrap
    // address would point the phone at itself, and the session would never be claimed.
    expect(usesLoopbackAddress("android")).toBe(true);
    expect(usesLoopbackAddress("ios-sim")).toBe(true);
    expect(usesLoopbackAddress("ios-device")).toBe(false);
  });
});

describe("deliverToOpenTarget: ios-sim", () => {
  test("happy path: preflight lists a booted device, then openurl is called with the deep link", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return { stdout: command === "xcrun" && args.includes("--json") ? bootedSimJson : "", stderr: "" };
    };

    await deliverToOpenTarget({ target: "ios-sim", deepLink: DEEP_LINK, wssPort: 8443, exec });

    expect(calls).toEqual([
      { command: "xcrun", args: ["simctl", "list", "devices", "booted", "--json"] },
      { command: "xcrun", args: ["simctl", "openurl", "AAAA", DEEP_LINK] },
    ]);
  });

  test("no booted simulator: a clear, actionable error and no openurl attempt", async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: noBootedSimJson, stderr: "" };
    };

    await expect(
      deliverToOpenTarget({ target: "ios-sim", deepLink: DEEP_LINK, wssPort: 8443, exec }),
    ).rejects.toThrow(/no booted ios simulator/iu);

    expect(calls).toHaveLength(1);
  });

  test("missing xcrun binary: a clear error naming the tool", async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error("spawn xcrun ENOENT"), { code: "ENOENT" });
    };

    await expect(
      deliverToOpenTarget({ target: "ios-sim", deepLink: DEEP_LINK, wssPort: 8443, exec }),
    ).rejects.toThrow(/"xcrun" was not found on PATH/u);
  });

  test("non-zero exit surfaces stderr", async () => {
    // First call (preflight) succeeds; the second (openurl) call fails with stderr set.
    let callCount = 0;
    const flakyExec: ExecFn = async () => {
      callCount += 1;

      if (callCount === 1) {
        return { stdout: bootedSimJson, stderr: "" };
      }

      throw Object.assign(new Error("Command failed"), { stderr: "simulator busy" });
    };

    await expect(
      deliverToOpenTarget({ target: "ios-sim", deepLink: DEEP_LINK, wssPort: 8443, exec: flakyExec }),
    ).rejects.toThrow(/simulator busy/u);
  });

  test("multiple booted simulators without --device: ambiguous, error names both", async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: twoBootedSimsJson, stderr: "" };
    };

    // Delivering to simctl's `booted` alias here would silently pick one of the two, and the
    // session would never be claimed — indistinguishable from a hung wait.
    await expect(
      deliverToOpenTarget({ target: "ios-sim", deepLink: DEEP_LINK, wssPort: 8443, exec }),
    ).rejects.toThrow(/iPhone 15 \(AAAA\).*iPad Pro \(BBBB\)/su);

    expect(calls).toHaveLength(1);
  });

  test("--device passthrough: openurl targets the udid directly, no preflight", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    await deliverToOpenTarget({
      target: "ios-sim",
      deepLink: DEEP_LINK,
      wssPort: 8443,
      device: "BBBB",
      exec,
    });

    expect(calls).toEqual([{ command: "xcrun", args: ["simctl", "openurl", "BBBB", DEEP_LINK] }]);
  });
});

describe("deliverToOpenTarget: ios-device", () => {
  test("happy path: devicectl lists one paired device into its --json-output file, then launches with --payload-url", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, devicectlListing([{ udid: "00008030-AAAA", name: "My iPhone" }]));

    await deliverToOpenTarget({
      target: "ios-device",
      deepLink: DEEP_LINK,
      wssPort: 8443,
      bundleId: BUNDLE_ID,
      exec,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("xcrun");
    expect(calls[0]!.args.slice(0, 5)).toEqual(["devicectl", "list", "devices", "--timeout", "5"]);
    expect(calls[0]!.args[5]).toBe("--json-output");
    expect(calls[1]).toEqual({
      command: "xcrun",
      args: launchArgs("00008030-AAAA", DEEP_LINK, BUNDLE_ID),
    });

    // The deep link is one argv element, unquoted: `execFile` never re-tokenizes and, unlike
    // android's `adb shell`, nothing re-parses it on the device.
    expect(calls[1]!.args).toContain(DEEP_LINK);
  });

  test("the --json-output temp directory is removed after a successful listing", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, devicectlListing([{ udid: "00008030-AAAA", name: "My iPhone" }]));

    await deliverToOpenTarget({
      target: "ios-device",
      deepLink: DEEP_LINK,
      wssPort: 8443,
      bundleId: BUNDLE_ID,
      exec,
    });

    const dirs = devicectlTempDirs(calls);
    expect(dirs).toHaveLength(1);
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  test("the temp directory is removed even when devicectl itself fails", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, undefined, {
      failList: Object.assign(new Error("Command failed"), { stderr: "no devices are available" }),
    });

    await expect(
      deliverToOpenTarget({
        target: "ios-device",
        deepLink: DEEP_LINK,
        wssPort: 8443,
        bundleId: BUNDLE_ID,
        exec,
      }),
    ).rejects.toThrow(/no devices are available/u);

    const dirs = devicectlTempDirs(calls);
    expect(dirs).toHaveLength(1);
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  test("--device passthrough: launches that udid directly, no list preflight", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, devicectlListing([]));

    await deliverToOpenTarget({
      target: "ios-device",
      deepLink: DEEP_LINK,
      wssPort: 8443,
      device: "00008030-BBBB",
      bundleId: BUNDLE_ID,
      exec,
    });

    expect(calls).toEqual([
      { command: "xcrun", args: launchArgs("00008030-BBBB", DEEP_LINK, BUNDLE_ID) },
    ]);
  });

  test("no paired device: a clear error naming what to check, and no launch attempt", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, devicectlListing([]));

    await expect(
      deliverToOpenTarget({
        target: "ios-device",
        deepLink: DEEP_LINK,
        wssPort: 8443,
        bundleId: BUNDLE_ID,
        exec,
      }),
    ).rejects.toThrow(/no connected ios device was found/iu);

    expect(calls).toHaveLength(1);
  });

  test("several paired devices: ambiguous, error names both, no launch attempt", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(
      calls,
      devicectlListing([
        { udid: "00008030-AAAA", name: "My iPhone" },
        { udid: "00008030-BBBB", name: "Test iPad" },
      ]),
    );

    await expect(
      deliverToOpenTarget({
        target: "ios-device",
        deepLink: DEEP_LINK,
        wssPort: 8443,
        bundleId: BUNDLE_ID,
        exec,
      }),
    ).rejects.toThrow(/My iPhone \(00008030-AAAA\).*Test iPad \(00008030-BBBB\)/su);

    expect(calls).toHaveLength(1);
  });

  test("missing bundle id: a usage error naming both ways to supply one, before anything is run", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, devicectlListing([{ udid: "00008030-AAAA", name: "My iPhone" }]));

    await expect(
      deliverToOpenTarget({ target: "ios-device", deepLink: DEEP_LINK, wssPort: 8443, exec }),
    ).rejects.toThrow(/--bundle-id.*iosBundleId/su);

    // Checked first: spending devicectl's list timeout would only delay the same error.
    expect(calls).toHaveLength(0);
  });

  test("missing xcrun binary: a clear error naming the tool", async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error("spawn xcrun ENOENT"), { code: "ENOENT" });
    };

    await expect(
      deliverToOpenTarget({
        target: "ios-device",
        deepLink: DEEP_LINK,
        wssPort: 8443,
        bundleId: BUNDLE_ID,
        exec,
      }),
    ).rejects.toThrow(/"xcrun" was not found on PATH/u);
  });

  test("a failing launch surfaces devicectl's stderr", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, devicectlListing([{ udid: "00008030-AAAA", name: "My iPhone" }]), {
      failLaunch: Object.assign(new Error("Command failed"), {
        stderr: "The application com.example.playground is not installed",
      }),
    });

    await expect(
      deliverToOpenTarget({
        target: "ios-device",
        deepLink: DEEP_LINK,
        wssPort: 8443,
        bundleId: BUNDLE_ID,
        exec,
      }),
    ).rejects.toThrow(/is not installed/u);
  });

  test("a device listed without hardwareProperties.udid falls back to its CoreDevice identifier", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(
      calls,
      devicectlListing([{ identifier: "1A2B-3C4D", name: "My iPhone" }]),
    );

    await deliverToOpenTarget({
      target: "ios-device",
      deepLink: DEEP_LINK,
      wssPort: 8443,
      bundleId: BUNDLE_ID,
      exec,
    });

    expect(calls[1]!.args[5]).toBe("1A2B-3C4D");
  });

  test("unparseable devicectl output reads as an empty listing, not a JSON syntax error", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, "not json at all");

    await expect(
      deliverToOpenTarget({
        target: "ios-device",
        deepLink: DEEP_LINK,
        wssPort: 8443,
        bundleId: BUNDLE_ID,
        exec,
      }),
    ).rejects.toThrow(/no connected ios device was found/iu);
  });

  test("devicectl exiting 0 without writing the file at all reads as an empty listing", async () => {
    // The ENOENT branch, distinct from "wrote something unparseable": `readFile` throws before
    // `JSON.parse` is ever reached, and that must still degrade to "no device found".
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    await expect(
      deliverToOpenTarget({
        target: "ios-device",
        deepLink: DEEP_LINK,
        wssPort: 8443,
        bundleId: BUNDLE_ID,
        exec,
      }),
    ).rejects.toThrow(/no connected ios device was found/iu);

    expect(calls).toHaveLength(1);
    expect(existsSync(devicectlTempDirs(calls)[0]!)).toBe(false);
  });
});

describe("deliverToOpenTarget: ios-device listing hygiene", () => {
  const deliverTo = async (
    devices: DevicectlFixtureDevice[],
    calls: Array<{ command: string; args: string[] }>,
  ): Promise<void> => {
    await deliverToOpenTarget({
      target: "ios-device",
      deepLink: DEEP_LINK,
      wssPort: 8443,
      bundleId: BUNDLE_ID,
      exec: devicectlExec(calls, devicectlListing(devices)),
    });
  };

  test("non-iOS CoreDevices are ignored, so a paired Watch/Vision Pro never creates ambiguity", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    // `devicectl list devices` returns every CoreDevice the Mac has paired, whatever the platform.
    // Counting these would turn the one deliverable iPhone into "multiple devices, specify --device".
    await deliverTo(
      [
        { udid: "WATCH-1", name: "My Watch", platform: "watchOS" },
        { udid: "VISION-1", name: "My Vision Pro", platform: "xrOS" },
        { udid: "MAC-1", name: "My Mac", platform: "macOS" },
        { udid: "00008030-AAAA", name: "My iPhone", platform: "iOS" },
      ],
      calls,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(launchArgs("00008030-AAAA", DEEP_LINK, BUNDLE_ID));
  });

  test("disconnected and unpaired devices are ignored, leaving the one that is actually reachable", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    await deliverTo(
      [
        { udid: "OLD-1", name: "Someone's old iPhone", tunnelState: "disconnected" },
        { udid: "OLD-2", name: "An iPad in a drawer", tunnelState: "unavailable" },
        { udid: "OLD-3", name: "A phone that was never trusted", pairingState: "unpaired" },
        { udid: "00008030-AAAA", name: "My iPhone", tunnelState: "connected", pairingState: "paired" },
      ],
      calls,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(launchArgs("00008030-AAAA", DEEP_LINK, BUNDLE_ID));
  });

  test("platform matching is case-insensitive, so an \"ios\" spelling is still deliverable", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    await deliverTo([{ udid: "00008030-AAAA", name: "My iPhone", platform: "ios" }], calls);

    expect(calls[1]!.args).toEqual(launchArgs("00008030-AAAA", DEEP_LINK, BUNDLE_ID));
  });

  test("a listing with none of the filter fields keeps the device rather than silently finding nothing", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    // Every one of these fields is undocumented. If a future devicectl stops emitting them, the
    // right failure is a loud launch error, not a silent "no device found" on a plugged-in phone.
    await deliverTo([{ udid: "00008030-AAAA", name: "My iPhone", platform: null }], calls);

    expect(calls[1]!.args).toEqual(launchArgs("00008030-AAAA", DEEP_LINK, BUNDLE_ID));
  });

  test("only disconnected/non-iOS entries: reports none found, and says what was ignored", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(
      deliverTo(
        [
          { udid: "WATCH-1", name: "My Watch", platform: "watchOS" },
          { udid: "OLD-1", name: "Someone's old iPhone", tunnelState: "disconnected" },
        ],
        calls,
      ),
    ).rejects.toThrow(/no connected ios device was found/iu);

    // The wording has to explain the disappearance, or a user staring at a Watch in Xcode's device
    // list has no idea why Cordierite says there is nothing there.
    await expect(deliverTo([{ udid: "WATCH-1", platform: "watchOS" }], [])).rejects.toThrow(
      /disconnected devices and non-iOS ones/iu,
    );

    expect(calls).toHaveLength(1);
  });

  test("two connected iOS devices are still ambiguous once filtering has run", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(
      deliverTo(
        [
          { udid: "00008030-AAAA", name: "My iPhone", tunnelState: "connected" },
          { udid: "00008030-BBBB", name: "Test iPad", tunnelState: "connected" },
          { udid: "WATCH-1", name: "My Watch", platform: "watchOS" },
        ],
        calls,
      ),
    ).rejects.toThrow(/My iPhone \(00008030-AAAA\).*Test iPad \(00008030-BBBB\)/su);

    // The Watch must not appear in the disambiguation list either — it is not a choice.
    await expect(
      deliverTo(
        [
          { udid: "00008030-AAAA", name: "My iPhone" },
          { udid: "00008030-BBBB", name: "Test iPad" },
          { udid: "WATCH-1", name: "My Watch", platform: "watchOS" },
        ],
        [],
      ),
    ).rejects.not.toThrow(/My Watch/u);
  });
});

describe("deliverToOpenTarget: ios-device bundle id validation", () => {
  const deliverWithBundleId = (bundleId: string, calls: Array<{ command: string; args: string[] }>) =>
    deliverToOpenTarget({
      target: "ios-device",
      deepLink: DEEP_LINK,
      wssPort: 8443,
      device: "00008030-AAAA",
      bundleId,
      exec: devicectlExec(calls, devicectlListing([])),
    });

  test("a bundle id starting with a dash is rejected before it can be read as a devicectl option", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    // The bundle id is the launch argv's only trailing positional: `--console` here would not be
    // "the app to launch", it would change what the command does.
    await expect(deliverWithBundleId("--console", calls)).rejects.toThrow(/not a valid iOS bundle id/u);
    await expect(deliverWithBundleId("-x", calls)).rejects.toThrow(/not a valid iOS bundle id/u);

    expect(calls).toEqual([]);
  });

  test("bundle ids containing shell/argv metacharacters or whitespace are rejected", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    for (const bad of ["com.example app", "com.example;rm -rf /", "com.example/../x", "com.$(id)"]) {
      await expect(deliverWithBundleId(bad, calls)).rejects.toThrow(/not a valid iOS bundle id/u);
    }

    expect(calls).toEqual([]);
  });

  test("ordinary reverse-DNS bundle ids, including digits and hyphens, are accepted", async () => {
    for (const good of ["com.example.playground", "com.example.my-app", "com.example.App2"]) {
      const calls: Array<{ command: string; args: string[] }> = [];
      await deliverWithBundleId(good, calls);
      expect(calls[0]!.args.at(-1)).toBe(good);
    }
  });
});

describe("deliverToOpenTarget: android", () => {
  test("happy path with ANDROID_SERIAL set: adb reverse before am start, deep link single-quoted", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    await deliverToOpenTarget({
      target: "android",
      deepLink: DEEP_LINK,
      wssPort: 8443,
      exec,
      env: { ANDROID_SERIAL: "emulator-5554" },
    });

    expect(calls).toEqual([
      { command: "adb", args: ["reverse", "tcp:8443", "tcp:8443"] },
      {
        command: "adb",
        args: ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${DEEP_LINK}'`],
      },
    ]);
  });

  test("exactly one attached device (no --device, no ANDROID_SERIAL): adb devices preflights, no -s flag needed", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });

      if (args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    };

    await deliverToOpenTarget({ target: "android", deepLink: DEEP_LINK, wssPort: 8443, exec, env: {} });

    expect(calls[0]).toEqual({ command: "adb", args: ["devices"] });
    expect(calls[1]!.args).toEqual(["reverse", "tcp:8443", "tcp:8443"]);
    expect(calls[2]!.args).not.toContain("-s");
  });

  test("no device attached: a clear error, nothing else runs", async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: "List of devices attached\n\n", stderr: "" };
    };

    await expect(
      deliverToOpenTarget({ target: "android", deepLink: DEEP_LINK, wssPort: 8443, exec, env: {} }),
    ).rejects.toThrow(/no android device or emulator is attached/iu);

    expect(calls).toEqual(["adb devices"]);
  });

  test("multiple devices without --device: ambiguous, error lists the serials", async () => {
    const exec: ExecFn = async (command, args) => {
      if (args[0] === "devices") {
        return {
          stdout: "List of devices attached\nemulator-5554\tdevice\nZY3239\tdevice\n\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };

    await expect(
      deliverToOpenTarget({ target: "android", deepLink: DEEP_LINK, wssPort: 8443, exec, env: {} }),
    ).rejects.toThrow(/emulator-5554.*ZY3239|ZY3239.*emulator-5554/su);
  });

  test("--device passthrough: adb -s <serial> ... for every subsequent call, no preflight adb devices call", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    await deliverToOpenTarget({
      target: "android",
      deepLink: DEEP_LINK,
      wssPort: 8443,
      device: "emulator-5554",
      exec,
      env: {},
    });

    expect(calls).toEqual([
      { command: "adb", args: ["-s", "emulator-5554", "reverse", "tcp:8443", "tcp:8443"] },
      {
        command: "adb",
        args: [
          "-s",
          "emulator-5554",
          "shell",
          "am",
          "start",
          "-a",
          "android.intent.action.VIEW",
          "-d",
          `'${DEEP_LINK}'`,
        ],
      },
    ]);
  });

  test("missing adb binary: a clear error naming the tool", async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" });
    };

    await expect(
      deliverToOpenTarget({ target: "android", deepLink: DEEP_LINK, wssPort: 8443, exec, env: {} }),
    ).rejects.toThrow(/"adb" was not found on PATH/u);
  });
});

describe("detectBootedTargets", () => {
  const oneAndroid = "List of devices attached\nemulator-5554\tdevice\n\n";
  const noAndroid = "List of devices attached\n\n";

  const execFor = (simStdout: string, adbStdout: string): ExecFn => {
    return async (command) => {
      if (command === "xcrun") {
        return { stdout: simStdout, stderr: "" };
      }
      return { stdout: adbStdout, stderr: "" };
    };
  };

  test("exactly one booted simulator: resolves it concretely, by udid", async () => {
    const detection = await detectBootedTargets({ exec: execFor(bootedSimJson, noAndroid), env: {} });

    expect(detection).toEqual({
      kind: "single",
      detected: { target: "ios-sim", device: "AAAA", label: "iPhone 15 (AAAA)" },
    });
  });

  test("exactly one attached android device: resolves it by serial", async () => {
    const detection = await detectBootedTargets({ exec: execFor(noBootedSimJson, oneAndroid), env: {} });

    expect(detection).toEqual({
      kind: "single",
      detected: { target: "android", device: "emulator-5554", label: "emulator-5554" },
    });
  });

  test("nothing booted or attached: none", async () => {
    const detection = await detectBootedTargets({ exec: execFor(noBootedSimJson, noAndroid), env: {} });

    expect(detection).toEqual({ kind: "none" });
  });

  test("a simulator and an emulator both up: ambiguous, listing both", async () => {
    const detection = await detectBootedTargets({ exec: execFor(bootedSimJson, oneAndroid), env: {} });

    expect(detection.kind).toBe("ambiguous");
    expect(detection.kind === "ambiguous" && detection.candidates.map((c) => c.target)).toEqual([
      "ios-sim",
      "android",
    ]);
  });

  test("two booted simulators: ambiguous rather than an arbitrary pick", async () => {
    const detection = await detectBootedTargets({ exec: execFor(twoBootedSimsJson, noAndroid), env: {} });

    expect(detection.kind).toBe("ambiguous");
    expect(detection.kind === "ambiguous" && detection.candidates.map((c) => c.device)).toEqual([
      "AAAA",
      "BBBB",
    ]);
  });

  test("ANDROID_SERIAL narrows the android side to that serial without listing", async () => {
    const commands: string[] = [];
    const exec: ExecFn = async (command) => {
      commands.push(command);
      return { stdout: command === "xcrun" ? noBootedSimJson : oneAndroid, stderr: "" };
    };

    const detection = await detectBootedTargets({ exec, env: { ANDROID_SERIAL: "ZY3239" } });

    expect(detection).toEqual({
      kind: "single",
      detected: { target: "android", device: "ZY3239", label: "ZY3239" },
    });
    expect(commands).not.toContain("adb");
  });

  test("a paired physical iPhone is never auto-detected, and devicectl is never even run", async () => {
    const invocations: string[] = [];
    const exec: ExecFn = async (command, args) => {
      invocations.push(`${command} ${args.join(" ")}`);

      // A `devicectl list devices` here would still find nothing to return through stdout, so the
      // real assertion is that it is never reached: the paired iPhone below stays invisible.
      if (command === "xcrun") {
        return { stdout: noBootedSimJson, stderr: "" };
      }

      return { stdout: noAndroid, stderr: "" };
    };

    // Nothing booted, nothing attached — but a paired iPhone would be sitting right there. It must
    // not turn into `{ kind: "single" }` and silently receive a link (issue #31: a paired iPhone is
    // often someone's personal phone, and delivery may cold-launch the app).
    await expect(detectBootedTargets({ exec, env: {} })).resolves.toEqual({ kind: "none" });

    expect(invocations.some((invocation) => invocation.includes("devicectl"))).toBe(false);
    expect(invocations).toEqual(["xcrun simctl list devices booted --json", "adb devices"]);
  });

  test("missing tooling is not an error: a machine with no xcrun/adb detects nothing", async () => {
    const exec: ExecFn = async (command) => {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    };

    // Detection runs when no target was named, so a missing toolchain has to degrade to the QR
    // fallback rather than failing the whole cordierite_connect call.
    await expect(detectBootedTargets({ exec, env: {} })).resolves.toEqual({ kind: "none" });
  });
});
