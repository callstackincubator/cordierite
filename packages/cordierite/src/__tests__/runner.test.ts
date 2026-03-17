import { describe, expect, test } from "bun:test";

import { executeHostedCommand } from "../cli/runner.js";
import { sessionError } from "../errors.js";
import { FIXED_NOW, fixedClock } from "./fixtures.js";

describe("executeHostedCommand", () => {
  test("interactive host mode passes ttl to the QR reporter", async () => {
    let qrArgs: { deepLink: string; ttlSeconds: number } | undefined;

    const exitCode = await executeHostedCommand(
      "host",
      async () => ({
        result: {
          ok: true,
          data: {
            host: {
              deep_link: "playground:///?cordierite=abc123",
              ttl_seconds: 45,
              spki_pin: "sha256/example",
              session_id: "RunnerHostTestSess01",
              wss_port: 8443,
              control_port: 41_000,
            },
          },
        },
        completion: Promise.resolve(),
        stop: () => {},
      }),
      {
        json: false,
        color: false,
        clock: fixedClock,
        stdout: {
          isTTY: true,
          write() {
            return true;
          },
        },
        stderr: {
          write() {
            return true;
          },
        },
        deviceStatus: {
          async printBootstrapQr(deepLink, ttlSeconds) {
            qrArgs = { deepLink, ttlSeconds };
          },
          onListening() {},
          onClaimed() {},
          onClaimedSessionEnded() {},
          dispose() {},
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(qrArgs).toEqual({
      deepLink: "playground:///?cordierite=abc123",
      ttlSeconds: 45,
    });
  });

  test("json host output stays single-shot when the hosted runtime later fails", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await executeHostedCommand(
      "host",
      async () => ({
        result: {
          ok: true,
          data: {
            host: {
              deep_link: "playground:///?cordierite=abc123",
              ttl_seconds: 1,
              spki_pin: "sha256/example",
              session_id: "RunnerHostTestSess01",
              wss_port: 8443,
              control_port: 41_000,
            },
          },
        },
        completion: Promise.reject(
          sessionError("Pending session TTL expired before any app connected."),
        ),
        stop: () => {},
      }),
      {
        json: true,
        color: false,
        clock: {
          now: () => new Date(FIXED_NOW.getTime() + 1_000),
        },
        stdout: {
          isTTY: false,
          write(chunk) {
            stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            return true;
          },
        },
        stderr: {
          write(chunk) {
            stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            return true;
          },
        },
      },
    );

    expect(exitCode).toBe(71);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: {
        host: {
          deep_link: "playground:///?cordierite=abc123",
          ttl_seconds: 1,
          spki_pin: "sha256/example",
          session_id: "RunnerHostTestSess01",
          wss_port: 8443,
          control_port: 41_000,
        },
      },
      meta: {
        command: "host",
        timestamp: new Date(FIXED_NOW.getTime() + 1_000).toISOString(),
        duration_ms: 0,
      },
    });
    expect(stderr).toBe("Pending session TTL expired before any app connected.\n");
  });
});
