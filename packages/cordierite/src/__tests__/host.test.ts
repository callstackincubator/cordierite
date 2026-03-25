import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";

import {
  createBootstrapDeepLink,
  createPendingSession,
  hasExpectedPostClaimSession,
  resolveAdvertisedHostIp,
} from "../commands/host.js";
import { generateHostCertificate } from "../host-certificate.js";
import {
  CONNECT_BOOTSTRAP_WIRE_BINARY_V1,
  toConnectBootstrapPayload,
  tryParseConnectBootstrapWireString,
} from "@cordierite/shared";

const padBase64 = (value: string): string => {
  const remainder = value.length % 4;

  if (remainder === 0) {
    return value;
  }

  return `${value}${"=".repeat(4 - remainder)}`;
};

const createPrivateKeyPem = (type: "ec" | "rsa" = "ec"): string => {
  const pair =
    type === "rsa"
      ? generateKeyPairSync("rsa", {
          modulusLength: 2048,
        })
      : generateKeyPairSync("ec", {
          namedCurve: "P-256",
        });

  return pair.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }).toString("utf8");
};

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

  test("resolveAdvertisedHostIp prefers loopback for simulator-opened sessions", () => {
    expect(resolveAdvertisedHostIp({ open: true })).toBe("127.0.0.1");
    expect(resolveAdvertisedHostIp({ open: true, ip: "192.168.1.42" })).toBe("192.168.1.42");
  });

  test("generateHostCertificate includes loopback SANs", async () => {
    const generated = await generateHostCertificate(createPrivateKeyPem(), "127.0.0.1");
    const certificate = new X509Certificate(generated.certPem);

    expect(certificate.subjectAltName).toContain("DNS:localhost");
    expect(certificate.subjectAltName).toContain("IP Address:127.0.0.1");
  });

  test("generateHostCertificate includes the explicit advertised LAN IP", async () => {
    const generated = await generateHostCertificate(createPrivateKeyPem(), "192.168.1.42");
    const certificate = new X509Certificate(generated.certPem);

    expect(certificate.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(certificate.subjectAltName).toContain("IP Address:192.168.1.42");
  });

  test("generateHostCertificate keeps the SPKI pin stable for the same key", async () => {
    const keyPem = createPrivateKeyPem("rsa");
    const first = await generateHostCertificate(keyPem, "127.0.0.1");
    const second = await generateHostCertificate(keyPem, "192.168.1.42");

    expect(first.spkiPin).toBe(second.spkiPin);
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

  test("claimed host requires known post-claim frames to match the active session", () => {
    expect(
      hasExpectedPostClaimSession(
        {
          type: "tool_registry_snapshot",
          session_id: "session-a",
          tools: [],
        },
        "session-a",
      ),
    ).toBe(true);

    expect(
      hasExpectedPostClaimSession(
        {
          type: "tool_registry_snapshot",
          session_id: "session-b",
          tools: [],
        },
        "session-a",
      ),
    ).toBe(false);

    expect(
      hasExpectedPostClaimSession(
        {
          type: "tool_result",
          session_id: "session-b",
          id: "call-1",
          result: { ok: true },
        },
        "session-a",
      ),
    ).toBe(false);

    expect(
      hasExpectedPostClaimSession(
        {
          type: "custom_message",
          payload: true,
        },
        "session-a",
      ),
    ).toBe(true);
  });
});
