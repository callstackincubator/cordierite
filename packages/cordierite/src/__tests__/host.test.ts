import { describe, expect, test } from "bun:test";

import {
  createBootstrapDeepLink,
  createPendingSession,
  getSpkiPinFromCertificate,
} from "../commands/host.js";
import {
  CONNECT_BOOTSTRAP_WIRE_BINARY_V1,
  toConnectBootstrapPayload,
  tryParseConnectBootstrapWireString,
} from "cordierite-shared";

const padBase64 = (value: string): string => {
  const remainder = value.length % 4;

  if (remainder === 0) {
    return value;
  }

  return `${value}${"=".repeat(4 - remainder)}`;
};

const SAMPLE_CERT = `-----BEGIN CERTIFICATE-----
MIIBszCCAVmgAwIBAgIUDzvN6W8D4ew3Efr2E1VlzDq+W8MwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwScGFsYW50aXItcG9jLWxvY2FsMB4XDTI2MDMxNzAwMDAwMFoX
DTM2MDMxNDAwMDAwMFowHTEbMBkGA1UEAwwScGFsYW50aXItcG9jLWxvY2FsMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5qZlQ5R4+VwMqqA0XQ29u0zJ1A+8y6nJ
vWJ4hZ8R3kM0s0JlbmT+7i9n0m8vQh4dKxXv4A0pcSxWvXKj1h8H4aNTMFEwHQYD
VR0OBBYEFM9w3oQ8kM7A2Z8VwU0Y2r7m0lDfMB8GA1UdIwQYMBaAFM9w3oQ8kM7A
2Z8VwU0Y2r7m0lDfMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIh
AIqjQwW2u2+9v0n9wQOQW7M2W8lE0wLwZ9rP2kU6v1wWAiEA3N0+H8N6O6Y7g8vV
8n4vB6z1mYgW3p4Bv7Yc4x1mVwA=
-----END CERTIFICATE-----`;

describe("host helpers", () => {
  test("createPendingSession creates a claimable record", () => {
    const session = createPendingSession(
      {
        ip: "192.168.1.42",
        port: 8443,
      },
      1_710_000_000,
      30,
    );

    expect(session.ip).toBe("192.168.1.42");
    expect(session.port).toBe(8443);
    expect(session.status).toBe("pending");
    expect(session.expires_at).toBe(1_710_000_030);
    expect(session.session_id).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
    expect(session.session_id.length).toBeGreaterThanOrEqual(16);
    expect(session.token.length).toBeGreaterThan(10);
    expect(session.tokenRaw.length).toBe(32);
  });

  test("createBootstrapDeepLink encodes the payload", () => {
    const session = createPendingSession(
      {
        ip: "192.168.1.42",
        port: 8443,
      },
      1_710_000_000,
      30,
    );

    const payload = toConnectBootstrapPayload(session);
    const deepLink = createBootstrapDeepLink(payload, "playground", session.tokenRaw);

    expect(deepLink.startsWith("playground:///?cordierite=")).toBe(true);
    expect(createBootstrapDeepLink(payload, "myapp", session.tokenRaw).startsWith("myapp:///?cordierite=")).toBe(
      true,
    );
    const encoded = deepLink.slice("playground:///?cordierite=".length);
    const bytes = Buffer.from(
      padBase64(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      "base64",
    );
    expect(bytes[0]).toBe(CONNECT_BOOTSTRAP_WIRE_BINARY_V1);
    expect(tryParseConnectBootstrapWireString(encoded)).toEqual(payload);
    const jsonWireLen = Buffer.byteLength(
      JSON.stringify([payload.ip, payload.port, payload.sessionId, payload.token, payload.expiresAt]),
      "utf8",
    );
    expect(bytes.length).toBeLessThan(jsonWireLen);
  });

  test("getSpkiPinFromCertificate rejects invalid certificates", () => {
    expect(() => getSpkiPinFromCertificate("not-a-certificate")).toThrow();
  });
});
