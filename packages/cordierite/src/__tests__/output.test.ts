import { describe, expect, test } from "vitest";

import type { DaemonStatusCommandData } from "../cli/result-types.js";
import { renderEventLine, renderEventsCursorLine, renderResult } from "../output.js";
import { FIXED_NOW } from "./fixtures.js";

describe("output rendering", () => {
  test("tools list output stays structured", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: [
          {
            name: "echo",
            description: "Echo a payload on the connected device.",
            input_schema: {},
            output_schema: { echoed: "unknown" },
          },
        ],
        meta: {
          command: "tools",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 4,
        },
      },
      {
        command: "tools",
        json: false,
        color: false,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("tools detail shows a declared timeout_ms, and no timeout line when the tool declares none", () => {
    const renderDetail = (timeoutMs?: number): string | undefined =>
      renderResult(
        {
          ok: true,
          data: {
            name: "login",
            description: "Signs a test user in.",
            ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
          },
          meta: { command: "tools", timestamp: FIXED_NOW.toISOString(), duration_ms: 4 },
        },
        { command: "tools", json: false, color: false },
      ).stdout;

    expect(renderDetail(60_000)).toContain("Timeout (ms)  60000");
    // A tool on the daemon's default must not render a number it never declared.
    expect(renderDetail()).not.toContain("Timeout (ms)");
  });

  test("tools detail output renders full schema/annotations", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          name: "echo",
          description: "Echo a payload on the connected device.",
          input_schema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        meta: {
          command: "tools",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 4,
        },
      },
      {
        command: "tools",
        json: false,
        color: false,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("link human output includes the deep link and expiry", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          sessionId: "LinkOutputTestSess1",
          deepLink: "playground:///?cordierite=abc123&pin=sha256%2Fexample",
          endpoint: { family: 4, address: "192.168.1.10", port: 8443 },
          expiresAt: Math.floor(FIXED_NOW.getTime() / 1000) + 30,
          pin: "sha256/example",
        },
        meta: {
          command: "link",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 5,
        },
      },
      {
        command: "link",
        json: false,
        color: false,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("link json output only includes the trimmed link payload (no QR)", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          sessionId: "LinkOutputTestSess1",
          deepLink: "playground:///?cordierite=abc123&pin=sha256%2Fexample",
          endpoint: { family: 4, address: "192.168.1.10", port: 8443 },
          expiresAt: Math.floor(FIXED_NOW.getTime() / 1000) + 30,
          pin: "sha256/example",
        },
        meta: {
          command: "link",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 5,
        },
      },
      {
        command: "link",
        json: true,
        color: false,
        qr: true,
      },
    );

    expect(JSON.parse(rendered.stdout ?? "")).toEqual({
      ok: true,
      data: {
        sessionId: "LinkOutputTestSess1",
        deepLink: "playground:///?cordierite=abc123&pin=sha256%2Fexample",
        endpoint: { family: 4, address: "192.168.1.10", port: 8443 },
        expiresAt: Math.floor(FIXED_NOW.getTime() / 1000) + 30,
        pin: "sha256/example",
      },
      meta: {
        command: "link",
        timestamp: FIXED_NOW.toISOString(),
        duration_ms: 5,
      },
    });
  });

  test("ls human output includes alias, state, device, tools, and age", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: [
          {
            sessionId: "LsOutputTestSess001",
            alias: "pixel-8",
            state: "active",
            device: { manufacturer: "Google", model: "Pixel 8", os: "Android 14" },
            createdAt: new Date(FIXED_NOW.getTime() - 65_000).toISOString(),
            claimedAt: new Date(FIXED_NOW.getTime() - 65_000).toISOString(),
            toolCount: 3,
          },
        ],
        meta: {
          command: "ls",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 2,
        },
      },
      {
        command: "ls",
        json: false,
        color: false,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("ls human output handles an empty session list", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: [],
        meta: {
          command: "ls",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 1,
        },
      },
      {
        command: "ls",
        json: false,
        color: false,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("keygen success output includes the key path and fingerprint", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          path: "/tmp/cordierite-key.pem",
          pin: "sha256/example",
        },
        meta: {
          command: "keygen",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 3,
        },
      },
      {
        command: "keygen",
        json: false,
        color: false,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("invoke human output prints the raw tool result", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: { echoed: "hello" },
        meta: {
          command: "invoke",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 6,
        },
      },
      {
        command: "invoke",
        json: false,
        color: false,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("human errors render on stderr", () => {
    const rendered = renderResult(
      {
        ok: false,
        error: {
          type: "tool_execution_error",
          message: "The tool handler threw.",
          details: {
            hint: "test",
          },
        },
        meta: {
          command: "invoke",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 2,
        },
      },
      {
        command: "invoke",
        json: false,
        color: false,
      },
    );

    expect(rendered.stderr).toMatchSnapshot();
  });

  test("json errors preserve the wire error type verbatim", () => {
    const rendered = renderResult(
      {
        ok: false,
        error: {
          type: "tool_execution_error",
          message: "The tool handler threw.",
        },
        meta: {
          command: "invoke",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 2,
        },
      },
      {
        command: "invoke",
        json: true,
        color: false,
      },
    );

    expect(JSON.parse(rendered.stdout ?? "").error.type).toBe("tool_execution_error");
  });
});

describe("renderEventLine", () => {
  test("NDJSON mode emits parseable, verbatim JSON", () => {
    const event = { kind: "session_claimed" as const, sessionId: "s1", alias: "pixel-8", ts: 1_700_000_000_000, data: {}, seq: 1 };
    const line = renderEventLine(event, { json: true, color: false });

    expect(JSON.parse(line)).toEqual(event);
  });

  test("human mode includes the kind and alias", () => {
    const line = renderEventLine(
      { kind: "tools_changed", sessionId: "s1", alias: "pixel-8", ts: 1_700_000_000_000, data: { toolCount: 2 }, seq: 1 },
      { json: false, color: false },
    );

    expect(line).toContain("tools_changed");
    expect(line).toContain("pixel-8");
  });
});

describe("renderEventsCursorLine", () => {
  test("NDJSON mode emits a parseable { cursor } object", () => {
    const line = renderEventsCursorLine(42, { json: true, color: false });
    expect(JSON.parse(line)).toEqual({ cursor: 42 });
  });

  test("human mode includes the cursor value and the resume flag", () => {
    const line = renderEventsCursorLine(42, { json: false, color: false });
    expect(line).toContain("42");
    expect(line).toContain("--since 42");
  });
});

describe("daemon status rendering", () => {
  const renderStatus = (audit: DaemonStatusCommandData["audit"]): string => {
    return renderResult(
      {
        ok: true,
        data: {
          daemon: {
            version: "0.7.0",
            pid: 4242,
            started_at: FIXED_NOW.toISOString(),
            wss_port: 8443,
            pinned_keys: ["sha256/abc"],
            session_count: 1,
          },
          policy: { default: "allow", destructive: "deny" },
          audit,
        } satisfies DaemonStatusCommandData,
        meta: { command: "daemon status", timestamp: FIXED_NOW.toISOString(), duration_ms: 4 },
      },
      { command: "daemon status", json: false, color: false },
    ).stdout ?? "";
  };

  test("renders the audit footprint with a human-readable size", () => {
    const stdout = renderStatus({
      path: "/tmp/state/audit",
      failed_writes: 0,
      failed_prunes: 2,
      retention_days: 30,
      files: 12,
      bytes: 1_572_864,
    });

    expect(stdout).toContain("Retention      30 days");
    expect(stdout).toContain("Files          12");
    expect(stdout).toContain("Size           1.5 MiB");
    expect(stdout).toContain("Failed prunes  2");
    expect(stdout).toMatchSnapshot();
  });

  test("scales byte sizes through the binary units, and leaves raw bytes undecorated", () => {
    // Matched loosely on the gap: `renderFields` pads labels to the widest *visible* one, which
    // changes with the rows this particular status happens to carry.
    const sizeRow = (bytes: number): string => {
      return /^ {2}Size +(.+)$/mu.exec(renderStatus({ path: "/a", failed_writes: 0, bytes, files: 1 }))?.[1] ?? "";
    };

    expect(sizeRow(0)).toBe("0 B");
    expect(sizeRow(512)).toBe("512 B");
    expect(sizeRow(1023)).toBe("1023 B");
    expect(sizeRow(1024)).toBe("1.0 KiB");
    expect(sizeRow(1536)).toBe("1.5 KiB");
    expect(sizeRow(10 * 1024 ** 3)).toBe("10.0 GiB");
    // Saturates at the largest unit rather than inventing one past TiB.
    expect(sizeRow(5 * 1024 ** 5)).toBe("5120.0 TiB");
  });

  test("omits the retention rows entirely for a daemon that predates them", () => {
    const stdout = renderStatus({ path: "/tmp/state/audit", failed_writes: 3 });

    // Never "undefined", and never an invented zero — the rows simply are not there.
    expect(stdout).not.toContain("undefined");
    expect(stdout).not.toContain("Retention");
    expect(stdout).not.toContain("Files");
    expect(stdout).not.toContain("Size");
    expect(stdout).not.toContain("Failed prunes");
    expect(stdout).toContain("Failed writes  3");
    expect(stdout).toMatchSnapshot();
  });
});
