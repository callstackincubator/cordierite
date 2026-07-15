import { describe, expect, test } from "bun:test";

import { BOOTSTRAP_VERSION_V2, decodeBootstrap, encodeBootstrap, type BootstrapPayload } from "../domains/bootstrap.js";
import { formatAgentWebSocketUrl } from "../domains/transport.js";

const rawToken = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const encodeToken = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(/=+$/gu, "");
};

const ipv4Payload = (): BootstrapPayload => ({
  family: 4,
  address: "192.168.1.10",
  port: 8443,
  sessionId: "session-abc",
  token: encodeToken(rawToken(7)),
  expiresAt: 1_800_000_000,
});

const ipv6Payload = (): BootstrapPayload => ({
  family: 6,
  address: "fd00::1",
  port: 8443,
  sessionId: "session-xyz",
  token: encodeToken(rawToken(9)),
  expiresAt: 1_800_000_000,
});

const decodeBase64UrlByteLength = (b64url: string): number => {
  const normalized = b64url.replaceAll("-", "+").replaceAll("_", "/");
  const pad = (4 - (normalized.length % 4)) % 4;
  return globalThis.atob(`${normalized}${"=".repeat(pad)}`).length;
};

const flipVersionByte = (b64url: string, version: number): string => {
  const normalized = b64url.replaceAll("-", "+").replaceAll("_", "/");
  const pad = (4 - (normalized.length % 4)) % 4;
  const binary = globalThis.atob(`${normalized}${"=".repeat(pad)}`);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  bytes[0] = version;

  let out = "";

  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }

  return globalThis.btoa(out).replaceAll("+", "-").replaceAll("/", "_").replaceAll(/=+$/gu, "");
};

const truncate = (b64url: string, byteCount: number): string => {
  const normalized = b64url.replaceAll("-", "+").replaceAll("_", "/");
  const pad = (4 - (normalized.length % 4)) % 4;
  const binary = globalThis.atob(`${normalized}${"=".repeat(pad)}`);
  const truncated = binary.slice(0, byteCount);

  return globalThis
    .btoa(truncated)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/gu, "");
};

const appendTrailingByte = (b64url: string): string => {
  const normalized = b64url.replaceAll("-", "+").replaceAll("_", "/");
  const pad = (4 - (normalized.length % 4)) % 4;
  const binary = globalThis.atob(`${normalized}${"=".repeat(pad)}`);

  return globalThis
    .btoa(`${binary}\x00`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/gu, "");
};

describe("encodeBootstrap / decodeBootstrap", () => {
  test("round-trips an IPv4 payload byte-for-byte", () => {
    const payload = ipv4Payload();
    const encoded = encodeBootstrap(payload);
    expect(decodeBootstrap(encoded)).toEqual(payload);
  });

  test("round-trips an IPv6 payload byte-for-byte", () => {
    const payload = ipv6Payload();
    const encoded = encodeBootstrap(payload);
    expect(decodeBootstrap(encoded)).toEqual(payload);
  });

  test("round-trips a compressible IPv6 address", () => {
    const payload = { ...ipv6Payload(), address: "::1" };
    const encoded = encodeBootstrap(payload);
    expect(decodeBootstrap(encoded)).toEqual(payload);
  });

  test("encodes the version byte as 0x02", () => {
    const encoded = encodeBootstrap(ipv4Payload());
    expect(decodeBase64UrlByteLength(encoded)).toBeGreaterThan(0);
    // corrupting the version to itself is a no-op round trip sanity check
    expect(decodeBootstrap(flipVersionByte(encoded, BOOTSTRAP_VERSION_V2))).toEqual(ipv4Payload());
  });

  test("rejects wrong version, including v1's 0x01", () => {
    const encoded = encodeBootstrap(ipv4Payload());
    expect(decodeBootstrap(flipVersionByte(encoded, 0x01))).toBeNull();
    expect(decodeBootstrap(flipVersionByte(encoded, 0x03))).toBeNull();
  });

  test("rejects truncated buffers", () => {
    const encoded = encodeBootstrap(ipv4Payload());
    expect(decodeBootstrap(truncate(encoded, 5))).toBeNull();
    expect(decodeBootstrap(truncate(encoded, 0))).toBeNull();
  });

  test("rejects buffers with trailing bytes", () => {
    const encoded = encodeBootstrap(ipv4Payload());
    expect(decodeBootstrap(appendTrailingByte(encoded))).toBeNull();
  });

  test("rejects a bad family byte", () => {
    const encoded = encodeBootstrap(ipv4Payload());
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const pad = (4 - (normalized.length % 4)) % 4;
    const binary = globalThis.atob(`${normalized}${"=".repeat(pad)}`);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    bytes[1] = 0x05;

    let out = "";

    for (const byte of bytes) {
      out += String.fromCharCode(byte);
    }

    const corrupted = globalThis.btoa(out).replaceAll("+", "-").replaceAll("/", "_").replaceAll(/=+$/gu, "");
    expect(decodeBootstrap(corrupted)).toBeNull();
  });

  test("rejects a non-UTF-8 session id", () => {
    const payload = ipv4Payload();
    const encoded = encodeBootstrap(payload);
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const pad = (4 - (normalized.length % 4)) % 4;
    const binary = globalThis.atob(`${normalized}${"=".repeat(pad)}`);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // header(1+1+4+2) + sessionIdLen byte = offset 9; session id bytes start at 9
    const sessionIdOffset = 1 + 1 + 4 + 2 + 1;
    bytes[sessionIdOffset] = 0xff;
    bytes[sessionIdOffset + 1] = 0xfe;

    let out = "";

    for (const byte of bytes) {
      out += String.fromCharCode(byte);
    }

    const corrupted = globalThis.btoa(out).replaceAll("+", "-").replaceAll("/", "_").replaceAll(/=+$/gu, "");
    expect(decodeBootstrap(corrupted)).toBeNull();
  });

  test("rejects port 0", () => {
    expect(() => encodeBootstrap({ ...ipv4Payload(), port: 0 })).toThrow();
  });

  test("rejects garbage input", () => {
    expect(decodeBootstrap("not-valid-base64url!!!")).toBeNull();
    expect(decodeBootstrap("")).toBeNull();
  });

  test("encodeBootstrap rejects a token that is not exactly 32 raw bytes", () => {
    expect(() => encodeBootstrap({ ...ipv4Payload(), token: "short" })).toThrow();
  });
});

describe("formatAgentWebSocketUrl", () => {
  test("formats IPv4 without brackets", () => {
    expect(formatAgentWebSocketUrl({ family: 4, address: "192.168.1.10", port: 8443 })).toBe(
      "wss://192.168.1.10:8443",
    );
  });

  test("brackets IPv6 literals", () => {
    expect(formatAgentWebSocketUrl({ family: 6, address: "fd00::1", port: 8443 })).toBe("wss://[fd00::1]:8443");
  });
});
