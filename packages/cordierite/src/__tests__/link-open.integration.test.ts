/**
 * `cordierite link --open android|ios-sim|ios-device` (ARCHITECTURE.md §8 delivery path
 * 1). Two layers are tested here against a real daemon over its actual UDS control socket (no
 * mocking the RPC layer, matching the pattern in session-engine.integration.test.ts):
 *
 * 1. `link.create`'s `addressOverride` param actually forces the encoded bootstrap address, port
 *    unchanged (`daemon/links.ts`/`daemon/sessions.ts`/`daemon/daemon.ts` wiring).
 * 2. `handleLinkCommand` with `--open` wires that override through and, given a stubbed
 *    `ExecFn` (`cli/open-target.ts`), delivers via the right adb/xcrun invocations before
 *    returning `delivered: true`. The experimental `ios-device` target is the one that must
 *    *not* get the override — a physical iPhone reaches the daemon only over the LAN (issue #31).
 */

import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { decodeBootstrap } from "@cordierite/shared";

import { handleLinkCommand } from "../commands/link.js";
import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import type { ExecFn } from "../cli/open-target.js";
import { writeTestHostKey } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (stateDirs.length > 0) {
    await rm(stateDirs.pop()!, { force: true, recursive: true });
  }
});

const pickFreePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
};

const startTestDaemon = async (
  extraConfig: Record<string, unknown> = {},
): Promise<{ daemon: RunningDaemon; stateDir: string; port: number }> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-link-open-"));
  stateDirs.push(stateDir);
  await writeTestHostKey(path.join(stateDir, "key.pem"));

  const port = await pickFreePort();
  await writeFile(
    path.join(stateDir, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "203.0.113.9", scheme: "playground", ...extraConfig }),
  );

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);

  return { daemon, stateDir, port };
};

/** Stub `exec` for the `ios-device` path: `devicectl list devices --json-output <file>` writes its
 * JSON to the *file* named in argv, so the stub has to produce that side effect. */
const devicectlExec = (
  calls: Array<{ command: string; args: string[] }>,
  devices: Array<{ udid: string; name: string }>,
): ExecFn => {
  return async (command, args) => {
    calls.push({ command, args });

    const jsonOutputIndex = args.indexOf("--json-output");

    if (jsonOutputIndex !== -1) {
      await writeFile(
        args[jsonOutputIndex + 1]!,
        JSON.stringify({
          result: {
            devices: devices.map((device) => ({
              deviceProperties: { name: device.name },
              hardwareProperties: { udid: device.udid, platform: "iOS" },
            })),
          },
        }),
        "utf8",
      );
    }

    return { stdout: "", stderr: "" };
  };
};

describe("link --open: daemon-level addressOverride", () => {
  test("link.create with addressOverride encodes that address, not the detected one", async () => {
    const { daemon } = await startTestDaemon();

    const { connect } = await import("node:net");
    const socket = connect(daemon.paths.socketPath);

    const result = await new Promise<{ deepLinkPayload: string; endpoint: { address: string } }>(
      (resolve, reject) => {
        socket.once("connect", () => {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "link.create",
              params: { ttlSeconds: 60, addressOverride: "127.0.0.1" },
            })}\n`,
          );
        });

        socket.once("data", (chunk) => {
          const parsed = JSON.parse(chunk.toString("utf8"));
          socket.destroy();

          if (parsed.error) {
            reject(new Error(parsed.error.message));
            return;
          }

          resolve(parsed.result);
        });

        socket.once("error", reject);
      },
    );

    expect(result.endpoint.address).toBe("127.0.0.1");

    const decoded = decodeBootstrap(result.deepLinkPayload);
    expect(decoded).not.toBeNull();
    expect(decoded!.address).toBe("127.0.0.1");
    expect(decoded!.family).toBe(4);
  });
});

describe("link --open: CLI wiring", () => {
  test("--open ios-sim forces 127.0.0.1, delivers via xcrun, and reports delivered: true", async () => {
    const { daemon, stateDir } = await startTestDaemon();

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });

      if (args.join(" ") === "simctl list devices booted --json") {
        return {
          stdout: JSON.stringify({ devices: { "iOS 17.0": [{ state: "Booted", udid: "ABC" }] } }),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    };

    const result = await handleLinkCommand(
      { open: "ios-sim" },
      { stateDir, exec },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected success");
    }

    expect(result.data.delivered).toBe(true);
    expect(result.data.target).toBe("ios-sim");

    // The deep link now carries a separate `&pin=...` query param after the bootstrap blob
    // (opt-in hardening dev-mode); only the `cordierite=` value up to the next `&` decodes.
    const decoded = decodeBootstrap(result.data.deepLink.split("cordierite=")[1]!.split("&")[0]!);
    expect(decoded!.address).toBe("127.0.0.1");

    expect(calls[0]).toEqual({ command: "xcrun", args: ["simctl", "list", "devices", "booted", "--json"] });
    expect(calls[1]!.command).toBe("xcrun");
    expect(calls[1]!.args[0]).toBe("simctl");
    expect(calls[1]!.args[1]).toBe("openurl");
    expect(calls[1]!.args[2]).toBe("ABC");
    expect(calls[1]!.args[3]).toBe(result.data.deepLink);

    void daemon;
  });

  test("--open android runs adb reverse before am start, quoting the deep link for the device shell", async () => {
    const { stateDir, port } = await startTestDaemon();

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    const result = await handleLinkCommand(
      { open: "android" },
      { stateDir, exec, env: { ANDROID_SERIAL: "emulator-5554" } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected success");
    }

    expect(result.data.delivered).toBe(true);
    expect(result.data.target).toBe("android");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("adb");
    expect(calls[0]!.args).toEqual(["reverse", `tcp:${port}`, `tcp:${port}`]);
    expect(calls[1]!.command).toBe("adb");
    expect(calls[1]!.args).toEqual([
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      `'${result.data.deepLink}'`,
    ]);
  });
});

describe("link --open ios-device: the LAN address, not 127.0.0.1", () => {
  test("--open ios-device mints the daemon's advertised address and launches via devicectl", async () => {
    const { stateDir } = await startTestDaemon({ iosBundleId: "com.example.playground" });

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, [{ udid: "00008030-AAAA", name: "My iPhone" }]);

    const result = await handleLinkCommand({ open: "ios-device" }, { stateDir, exec });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected success");
    }

    expect(result.data.delivered).toBe(true);
    expect(result.data.target).toBe("ios-device");

    // The whole point of the target: a physical iPhone has no `adb reverse` equivalent, so the
    // bootstrap blob must carry the machine's LAN address. `127.0.0.1` here would point the phone
    // at itself and the session would silently never be claimed.
    const decoded = decodeBootstrap(result.data.deepLink.split("cordierite=")[1]!.split("&")[0]!);
    expect(decoded).not.toBeNull();
    expect(decoded!.address).toBe("203.0.113.9");
    expect(result.data.endpoint.address).toBe("203.0.113.9");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args.slice(0, 5)).toEqual(["devicectl", "list", "devices", "--timeout", "5"]);
    expect(calls[1]).toEqual({
      command: "xcrun",
      args: [
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        "00008030-AAAA",
        "--terminate-existing",
        "--payload-url",
        result.data.deepLink,
        "com.example.playground",
      ],
    });
  });

  test("--bundle-id overrides config.json's iosBundleId", async () => {
    const { stateDir } = await startTestDaemon({ iosBundleId: "com.example.fromconfig" });

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, [{ udid: "00008030-AAAA", name: "My iPhone" }]);

    const result = await handleLinkCommand(
      { open: "ios-device", bundleId: "com.example.fromflag" },
      { stateDir, exec },
    );

    expect(result.ok).toBe(true);
    expect(calls[1]!.args.at(-1)).toBe("com.example.fromflag");
  });

  test("no bundle id anywhere: a usage error, and no link is minted or delivered", async () => {
    const { stateDir } = await startTestDaemon();

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, [{ udid: "00008030-AAAA", name: "My iPhone" }]);

    await expect(handleLinkCommand({ open: "ios-device" }, { stateDir, exec })).rejects.toThrow(
      /--bundle-id.*iosBundleId/su,
    );

    // Raised before `link.create`, so a call that could never deliver does not leave a pending
    // session behind to expire on its own TTL.
    expect(calls).toHaveLength(0);
  });

  test("--bundle-id without --open ios-device is a usage error", async () => {
    const { stateDir } = await startTestDaemon();

    await expect(
      handleLinkCommand({ open: "ios-sim", bundleId: "com.example.playground" }, { stateDir }),
    ).rejects.toThrow(/"--bundle-id" only applies with "--open ios-device"/u);

    await expect(
      handleLinkCommand({ bundleId: "com.example.playground" }, { stateDir }),
    ).rejects.toThrow(/"--bundle-id" only applies with "--open ios-device"/u);
  });

  test("an unknown --open value names every accepted target", async () => {
    const { stateDir } = await startTestDaemon();

    await expect(handleLinkCommand({ open: "ios" }, { stateDir })).rejects.toThrow(
      /"android", "ios-sim", "ios-device"/u,
    );
  });

  test("a --bundle-id that could be read as a devicectl option is rejected before minting", async () => {
    const { stateDir } = await startTestDaemon();

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, [{ udid: "00008030-AAAA", name: "My iPhone" }]);

    await expect(
      handleLinkCommand({ open: "ios-device", bundleId: "--console" }, { stateDir, exec }),
    ).rejects.toThrow(/not a valid iOS bundle id/u);

    expect(calls).toEqual([]);
  });
});

describe("client link({ target: \"ios-device\" })", () => {
  test("the programmatic client takes the same path as the CLI: LAN address, devicectl launch", async () => {
    const { stateDir } = await startTestDaemon({ iosBundleId: "com.example.playground" });

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, [{ udid: "00008030-AAAA", name: "My iPhone" }]);

    // `cordierite/client`'s `link()` is what a test's globalSetup calls; it must not drift from
    // `cordierite link` (both go through `mintLink`, and this is the test that says so).
    const { link } = await import("../client/bootstrap.js");
    const result = await link({ stateDir, target: "ios-device", exec, autoSpawn: false });

    expect(result.delivered).toBe(true);
    expect(result.target).toBe("ios-device");

    const decoded = decodeBootstrap(result.deepLink.split("cordierite=")[1]!.split("&")[0]!);
    expect(decoded!.address).toBe("203.0.113.9");

    expect(calls[1]!.args).toEqual([
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      "00008030-AAAA",
      "--terminate-existing",
      "--payload-url",
      result.deepLink,
      "com.example.playground",
    ]);
  });

  test("the programmatic client surfaces a missing bundle id as a CordieriteError", async () => {
    const { stateDir } = await startTestDaemon();

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = devicectlExec(calls, [{ udid: "00008030-AAAA", name: "My iPhone" }]);

    const { link } = await import("../client/bootstrap.js");

    await expect(
      link({ stateDir, target: "ios-device", exec, autoSpawn: false }),
    ).rejects.toThrow(/iosBundleId/u);

    expect(calls).toEqual([]);
  });
});
