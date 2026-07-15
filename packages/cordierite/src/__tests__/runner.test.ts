import { describe, expect, test } from "bun:test";

import { executeHostedCommand } from "../cli/runner.js";
import { sessionError } from "../errors.js";
import { FIXED_NOW, fixedClock } from "./fixtures.js";

describe("executeHostedCommand", () => {
  test("reporter is disposed after hosted command completion", async () => {
    let disposed = 0;
    const exitCode = await executeHostedCommand(
      "daemon run",
      async () => ({
        result: {
          ok: true,
          data: {
            daemon: {
              pid: 4242,
              state_dir: "/tmp/cordierite-state",
              socket_path: "/tmp/cordierite-state/daemon.sock",
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
        reporter: {
          kind: "plain",
          onEvent() {},
          dispose() {
            disposed += 1;
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(disposed).toBe(1);
  });

  test("a live (non-plain) reporter suppresses the default bootstrap render", async () => {
    let stdout = "";

    const exitCode = await executeHostedCommand(
      "events",
      async () => ({
        result: { ok: true, data: undefined },
        completion: Promise.resolve(),
        stop: () => {},
      }),
      {
        json: false,
        color: false,
        clock: fixedClock,
        stdout: {
          isTTY: false,
          write(chunk) {
            stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            return true;
          },
        },
        stderr: {
          write() {
            return true;
          },
        },
        reporter: {
          kind: "interactive",
          onEvent() {},
          dispose() {},
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("json output stays single-shot when the hosted runtime later fails", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await executeHostedCommand(
      "daemon run",
      async () => ({
        result: {
          ok: true,
          data: {
            daemon: {
              pid: 4242,
              state_dir: "/tmp/cordierite-state",
              socket_path: "/tmp/cordierite-state/daemon.sock",
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
        daemon: {
          pid: 4242,
          state_dir: "/tmp/cordierite-state",
          socket_path: "/tmp/cordierite-state/daemon.sock",
        },
      },
      meta: {
        command: "daemon run",
        timestamp: new Date(FIXED_NOW.getTime() + 1_000).toISOString(),
        duration_ms: 0,
      },
    });

    // The v1 defect this guards against: a bare, unparseable text line on stderr in --json mode.
    // The fix (runner.ts) emits a full JSON object instead, once stdout's single-object contract is
    // already fulfilled by the bootstrap render above.
    expect(() => JSON.parse(stderr)).not.toThrow();
    const parsedStderr = JSON.parse(stderr);
    expect(parsedStderr.ok).toBe(false);
    expect(parsedStderr.error.type).toBe("session_error");
    expect(parsedStderr.error.message).toBe("Pending session TTL expired before any app connected.");
  });
});
