import { describe, expect, test } from "bun:test";

import { renderResult } from "../output.js";
import { FIXED_NOW } from "./fixtures.js";

describe("output rendering", () => {
  test("human success output stays structured", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          tools: [
            {
              name: "app.echo",
              description: "Echo a payload on the connected device.",
              input_schema: {},
              output_schema: { echoed: "unknown" },
            },
          ],
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

  test("host success output includes session, ports, fingerprint, deep link, and ttl", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          host: {
            deep_link: "playground:///?cordierite=abc123",
            ttl_seconds: 30,
            spki_pin: "sha256/example",
            session_id: "HostOutputTestSess1",
            wss_port: 8443,
            control_port: 41_000,
          },
        },
        meta: {
          command: "host",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 5,
        },
      },
      {
        command: "host",
        json: false,
        color: false,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("host json output only includes the trimmed host payload", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          host: {
            deep_link: "playground:///?cordierite=abc123",
            ttl_seconds: 30,
            spki_pin: "sha256/example",
            session_id: "HostOutputTestSess1",
            wss_port: 8443,
            control_port: 41_000,
          },
        },
        meta: {
          command: "host",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 5,
        },
      },
      {
        command: "host",
        json: true,
        color: false,
      },
    );

    expect(JSON.parse(rendered.stdout ?? "")).toEqual({
      ok: true,
      data: {
        host: {
          deep_link: "playground:///?cordierite=abc123",
          ttl_seconds: 30,
          spki_pin: "sha256/example",
          session_id: "HostOutputTestSess1",
          wss_port: 8443,
          control_port: 41_000,
        },
      },
      meta: {
        command: "host",
        timestamp: FIXED_NOW.toISOString(),
        duration_ms: 5,
      },
    });
  });

  test("human errors render on stderr", () => {
    const rendered = renderResult(
      {
        ok: false,
        error: {
          type: "validation_error",
          message: "Bootstrap payload is invalid.",
          details: {
            require_private_ip: true,
          },
        },
        meta: {
          command: "connect",
          timestamp: FIXED_NOW.toISOString(),
          duration_ms: 2,
        },
      },
      {
        command: "connect",
        json: false,
        color: false,
      },
    );

    expect(rendered.stderr).toMatchSnapshot();
  });
});
