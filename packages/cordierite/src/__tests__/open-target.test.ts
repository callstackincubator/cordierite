/**
 * Unit tests for `cli/open-target.ts`, covering its acceptance matrix and all driven through the
 * injectable `ExecFn` seam — no real `adb`/`xcrun` process is ever spawned.
 */

import { describe, expect, test } from "vitest";

import { deliverToOpenTarget, isOpenTarget, type ExecFn } from "../cli/open-target.js";

const DEEP_LINK = "playground:///?cordierite=abc123";

const bootedSimJson = JSON.stringify({
  devices: { "iOS 17.0": [{ state: "Booted", udid: "AAAA" }] },
});

const noBootedSimJson = JSON.stringify({
  devices: { "iOS 17.0": [{ state: "Shutdown", udid: "AAAA" }] },
});

describe("isOpenTarget", () => {
  test("accepts android/ios-sim, rejects anything else", () => {
    expect(isOpenTarget("android")).toBe(true);
    expect(isOpenTarget("ios-sim")).toBe(true);
    expect(isOpenTarget("ios")).toBe(false);
    expect(isOpenTarget("")).toBe(false);
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
      { command: "xcrun", args: ["simctl", "openurl", "booted", DEEP_LINK] },
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
