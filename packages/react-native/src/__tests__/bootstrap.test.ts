import { encodeBootstrap, type BootstrapPayload } from "@cordierite/shared";
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { CordieriteBootstrapParseError } from "../Cordierite.types";
import { parseBootstrapPayload, parseBootstrapUrl } from "../bootstrap";

const FIXED_NOW = 1_710_000_000;

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/gu, "");
};

const token32B64Url = (): string =>
  bytesToBase64Url(new Uint8Array(randomBytes(32)));

const payload = (): BootstrapPayload => ({
  family: 4,
  address: "192.168.1.42",
  port: 8443,
  sessionId: "session-123",
  token: token32B64Url(),
  expiresAt: FIXED_NOW + 30,
});

const binaryPayloadB64 = (p: BootstrapPayload): string => encodeBootstrap(p);

describe("bootstrap helpers", () => {
  test("parseBootstrapPayload accepts loopback when local-only validation is enabled", () => {
    const loopbackPayload = { ...payload(), address: "127.0.0.1" };

    expect(
      parseBootstrapPayload(binaryPayloadB64(loopbackPayload), {
        now: FIXED_NOW,
        requirePrivateIp: true,
      })
    ).toEqual(loopbackPayload);
  });

  test("parseBootstrapPayload accepts a valid v2 bootstrap blob", () => {
    const p = payload();
    expect(
      parseBootstrapPayload(binaryPayloadB64(p), {
        now: FIXED_NOW,
      })
    ).toEqual(p);
  });

  test("parseBootstrapPayload rejects raw JSON", () => {
    expect(() =>
      parseBootstrapPayload(JSON.stringify(payload()), {
        now: FIXED_NOW,
      })
    ).toThrow(CordieriteBootstrapParseError);
  });

  test("parseBootstrapPayload rejects a v1-shaped base64url-encoded JSON payload", () => {
    const p = payload();
    const wire = [p.address, p.port, p.sessionId, p.token, p.expiresAt];
    const rawPayload = bytesToBase64Url(
      new TextEncoder().encode(JSON.stringify(wire))
    );

    expect(() =>
      parseBootstrapPayload(rawPayload, {
        now: FIXED_NOW,
      })
    ).toThrow(CordieriteBootstrapParseError);
  });

  test("parseBootstrapPayload rejects expired payloads", () => {
    const expired = { ...payload(), expiresAt: FIXED_NOW - 1 };

    expect(() =>
      parseBootstrapPayload(binaryPayloadB64(expired), {
        now: FIXED_NOW,
      })
    ).toThrow(CordieriteBootstrapParseError);
  });

  test("parseBootstrapUrl accepts a compact v2 bootstrap payload", () => {
    const p = payload();
    const rawPayload = binaryPayloadB64(p);

    expect(
      parseBootstrapUrl(`playground:///?cordierite=${rawPayload}`, {
        now: FIXED_NOW,
      })
    ).toEqual(p);
  });

  test("parseBootstrapUrl decodes via atob when Buffer is unavailable", () => {
    const p = payload();
    const rawPayload = binaryPayloadB64(p);

    const g = globalThis as { Buffer?: typeof Buffer };
    const prevBuffer = g.Buffer;
    delete g.Buffer;

    try {
      expect(
        parseBootstrapUrl(`playground:///?cordierite=${rawPayload}`, {
          now: FIXED_NOW,
        })
      ).toEqual(p);
    } finally {
      g.Buffer = prevBuffer;
    }
  });
});
