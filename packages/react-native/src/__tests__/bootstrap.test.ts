import { encodeConnectBootstrapWireBinary } from "@cordierite/shared";
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { CordieriteBootstrapParseError } from "../Cordierite.types";
import { parseBootstrapPayload, parseBootstrapUrl } from "../bootstrap";

const padBase64Url = (value: string): string => {
  return value
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/gu, "");
};

const FIXED_NOW = 1_710_000_000;

const payload = {
  ip: "192.168.1.42",
  port: 8443,
  sessionId: "session-123",
  token: "token-123",
  expiresAt: FIXED_NOW + 30,
};

const token32B64Url = (): string =>
  Buffer.from(randomBytes(32))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const binaryPayloadB64 = (p: typeof payload): string =>
  padBase64Url(
    Buffer.from(encodeConnectBootstrapWireBinary(p)).toString("base64")
  );

describe("bootstrap helpers", () => {
  test("parseBootstrapPayload accepts loopback when local-only validation is enabled", () => {
    const token = token32B64Url();
    const loopbackPayload = { ...payload, ip: "127.0.0.1", token };

    expect(
      parseBootstrapPayload(binaryPayloadB64(loopbackPayload), {
        now: FIXED_NOW,
        requirePrivateIp: true,
      })
    ).toEqual(loopbackPayload);
  });

  test("parseBootstrapPayload accepts base64url binary v1", () => {
    const token = token32B64Url();
    const p = { ...payload, token };
    expect(
      parseBootstrapPayload(binaryPayloadB64(p), {
        now: FIXED_NOW,
      })
    ).toEqual(p);
  });

  test("parseBootstrapPayload rejects raw JSON", () => {
    expect(() =>
      parseBootstrapPayload(JSON.stringify(payload), {
        now: FIXED_NOW,
      })
    ).toThrow(CordieriteBootstrapParseError);
  });

  test("parseBootstrapPayload rejects base64url-encoded JSON", () => {
    const wire = [
      payload.ip,
      payload.port,
      payload.sessionId,
      payload.token,
      payload.expiresAt,
    ];
    const rawPayload = padBase64Url(
      Buffer.from(JSON.stringify(wire), "utf8").toString("base64")
    );

    expect(() =>
      parseBootstrapPayload(rawPayload, {
        now: FIXED_NOW,
      })
    ).toThrow(CordieriteBootstrapParseError);
  });

  test("parseBootstrapPayload rejects expired payloads", () => {
    const token = token32B64Url();
    const expired = { ...payload, token, expiresAt: FIXED_NOW - 1 };

    expect(() =>
      parseBootstrapPayload(binaryPayloadB64(expired), {
        now: FIXED_NOW,
      })
    ).toThrow(CordieriteBootstrapParseError);
  });

  test("parseBootstrapUrl accepts compact binary v1 payload", () => {
    const token = token32B64Url();
    const binaryPayload = { ...payload, token };
    const rawPayload = binaryPayloadB64(binaryPayload);

    expect(
      parseBootstrapUrl(`playground:///?cordierite=${rawPayload}`, {
        now: FIXED_NOW,
      })
    ).toEqual(binaryPayload);
  });

  test("parseBootstrapUrl decodes binary v1 via atob when Buffer is unavailable", () => {
    const token = token32B64Url();
    const binaryPayload = { ...payload, token };
    const rawPayload = binaryPayloadB64(binaryPayload);

    const g = globalThis as { Buffer?: typeof Buffer };
    const prevBuffer = g.Buffer;
    delete g.Buffer;

    try {
      expect(
        parseBootstrapUrl(`playground:///?cordierite=${rawPayload}`, {
          now: FIXED_NOW,
        })
      ).toEqual(binaryPayload);
    } finally {
      g.Buffer = prevBuffer;
    }
  });
});
