import type { PendingSessionRecord, UnixTimestampSeconds } from "./session.js";
import { isExpiredAt } from "./session.js";
import { isPrivateIpv4Address, isValidPort } from "./transport.js";

export type ConnectBootstrapPayload = {
  ip: string;
  port: number;
  sessionId: string;
  token: string;
  expiresAt: UnixTimestampSeconds;
};

/** Binary v1: `0x01` + packed IPv4, port, sessionId (u8 len + utf-8), 32-byte token, u32 expiresAt (BE). */
export const CONNECT_BOOTSTRAP_WIRE_BINARY_V1 = 1;

const BINARY_V1_TOKEN_BYTES = 32;
const BINARY_V1_MIN_LENGTH = 1 + 4 + 2 + 1 + BINARY_V1_TOKEN_BYTES + 4;

const textEncoder = new TextEncoder();

const decodeBase64UrlToBytes = (input: string): Uint8Array | null => {
  if (input.length === 0) {
    return null;
  }

  try {
    const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
    const pad = (4 - (normalized.length % 4)) % 4;
    const b64 = `${normalized}${"=".repeat(pad)}`;

    const BufferMaybe = (
      globalThis as {
        Buffer?: { from(data: string, encoding: string): Uint8Array };
      }
    ).Buffer;

    if (BufferMaybe) {
      return new Uint8Array(BufferMaybe.from(b64, "base64"));
    }

    if (typeof globalThis.atob === "function") {
      const binary = globalThis.atob(b64);
      const out = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
      }

      return out;
    }
  } catch {
    return null;
  }

  return null;
};

const encodeBytesToBase64Url = (bytes: Uint8Array): string => {
  let b64: string;

  if (typeof globalThis.btoa === "function") {
    let binary = "";

    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }

    b64 = globalThis.btoa(binary);
  } else {
    const BufferMaybe = (
      globalThis as {
        Buffer?: { from(data: Uint8Array): { toString(enc: string): string } };
      }
    ).Buffer;

    if (!BufferMaybe) {
      throw new Error("Base64 encoding is not available in this runtime.");
    }

    b64 = BufferMaybe.from(bytes).toString("base64");
  }

  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll(/=+$/gu, "");
};

const ipv4StringToUint32 = (ip: string): number | null => {
  const parts = ip.split(".");

  if (parts.length !== 4) {
    return null;
  }

  let n = 0;

  for (let i = 0; i < 4; i++) {
    const x = Number(parts[i]);

    if (!Number.isInteger(x) || x < 0 || x > 255) {
      return null;
    }

    n = (n << 8) | x;
  }

  return n >>> 0;
};

const uint32ToIpv4 = (n: number): string => {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
};

const writeU32BE = (out: Uint8Array, offset: number, v: number): void => {
  out[offset] = (v >>> 24) & 255;
  out[offset + 1] = (v >>> 16) & 255;
  out[offset + 2] = (v >>> 8) & 255;
  out[offset + 3] = v & 255;
};

const writeU16BE = (out: Uint8Array, offset: number, v: number): void => {
  out[offset] = (v >>> 8) & 255;
  out[offset + 1] = v & 255;
};

const readU32BE = (data: Uint8Array, offset: number): number => {
  return (
    ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>>
      0
  );
};

const readU16BE = (data: Uint8Array, offset: number): number => {
  return (data[offset]! << 8) | data[offset + 1]!;
};

const payloadFromParts = (
  ip: unknown,
  port: unknown,
  sessionId: unknown,
  token: unknown,
  expiresAt: unknown,
): ConnectBootstrapPayload | null => {
  if (
    typeof ip !== "string" ||
    !isValidPort(port) ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof expiresAt !== "number" ||
    !Number.isInteger(expiresAt)
  ) {
    return null;
  }

  return {
    ip,
    port,
    sessionId,
    token,
    expiresAt,
  };
};

/** Coerce an in-memory value to {@link ConnectBootstrapPayload} (camelCase object only). */
export const normalizeConnectBootstrapWire = (value: unknown): ConnectBootstrapPayload | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  return payloadFromParts(record.ip, record.port, record.sessionId, record.token, record.expiresAt);
};

export type ConnectBootstrapValidationOptions = {
  now?: UnixTimestampSeconds;
  requirePrivateIp?: boolean;
};

export const validateConnectBootstrapPayload = (
  payload: ConnectBootstrapPayload,
  options: ConnectBootstrapValidationOptions = {},
): boolean => {
  const now = options.now;
  const requirePrivateIp = options.requirePrivateIp ?? false;

  if (requirePrivateIp && !isPrivateIpv4Address(payload.ip)) {
    return false;
  }

  if (now !== undefined && isExpiredAt(payload.expiresAt, now)) {
    return false;
  }

  return true;
};

export const isConnectBootstrapPayload = (
  value: unknown,
  options: ConnectBootstrapValidationOptions = {},
): boolean => {
  const payload = normalizeConnectBootstrapWire(value);

  if (!payload) {
    return false;
  }

  return validateConnectBootstrapPayload(payload, options);
};

export const toConnectBootstrapPayload = (
  session: PendingSessionRecord,
): ConnectBootstrapPayload => {
  return {
    ip: session.ip,
    port: session.port,
    sessionId: session.session_id,
    token: session.token,
    expiresAt: session.expires_at,
  };
};

/**
 * Host/agent: shortest on-the-wire form for the deep link (requires IPv4 + 32-byte token semantics).
 * Pass `tokenRaw` when the caller already holds the 32 random bytes (avoids base64 decode mismatches).
 */
export const encodeConnectBootstrapWireBinary = (
  payload: ConnectBootstrapPayload,
  tokenRaw?: Uint8Array,
): Uint8Array => {
  const tokenBytes =
    tokenRaw !== undefined && tokenRaw.length === BINARY_V1_TOKEN_BYTES
      ? tokenRaw
      : decodeBase64UrlToBytes(payload.token);

  if (tokenBytes === null || tokenBytes.length !== BINARY_V1_TOKEN_BYTES) {
    throw new Error(
      "Cordierite binary bootstrap requires a token that base64url-decodes to exactly 32 bytes.",
    );
  }

  const sidBytes = textEncoder.encode(payload.sessionId);

  if (sidBytes.length === 0 || sidBytes.length > 255) {
    throw new Error("Cordierite binary bootstrap sessionId must be 1–255 UTF-8 bytes.");
  }

  const ipNum = ipv4StringToUint32(payload.ip);

  if (ipNum === null) {
    throw new Error("Cordierite binary bootstrap requires a dotted IPv4 address.");
  }

  if (!isValidPort(payload.port)) {
    throw new Error("Cordierite binary bootstrap has an invalid port.");
  }

  const exp = payload.expiresAt >>> 0;

  if (exp !== payload.expiresAt) {
    throw new Error("Cordierite binary bootstrap expiresAt must fit in 32 bits.");
  }

  const out = new Uint8Array(1 + 4 + 2 + 1 + sidBytes.length + BINARY_V1_TOKEN_BYTES + 4);
  let o = 0;
  out[o++] = CONNECT_BOOTSTRAP_WIRE_BINARY_V1;
  writeU32BE(out, o, ipNum);
  o += 4;
  writeU16BE(out, o, payload.port);
  o += 2;
  out[o++] = sidBytes.length;
  out.set(sidBytes, o);
  o += sidBytes.length;
  out.set(tokenBytes, o);
  o += BINARY_V1_TOKEN_BYTES;
  writeU32BE(out, o, exp);

  return out;
};

export const decodeConnectBootstrapWireBinary = (data: Uint8Array): ConnectBootstrapPayload | null => {
  if (data.length < BINARY_V1_MIN_LENGTH || data[0] !== CONNECT_BOOTSTRAP_WIRE_BINARY_V1) {
    return null;
  }

  let o = 1;
  const ipNum = readU32BE(data, o);
  o += 4;
  const port = readU16BE(data, o);
  o += 2;
  const sidLen = data[o]!;

  o += 1;

  if (sidLen === 0 || o + sidLen + BINARY_V1_TOKEN_BYTES + 4 !== data.length) {
    return null;
  }

  const sidBytes = data.subarray(o, o + sidLen);
  o += sidLen;
  const tokenBytes = data.subarray(o, o + BINARY_V1_TOKEN_BYTES);
  o += BINARY_V1_TOKEN_BYTES;
  const expiresAt = readU32BE(data, o);

  let sessionId: string;

  try {
    sessionId = new TextDecoder("utf-8", { fatal: true }).decode(sidBytes);
  } catch {
    return null;
  }

  const ip = uint32ToIpv4(ipNum);
  const token = encodeBytesToBase64Url(tokenBytes);

  return payloadFromParts(ip, port, sessionId, token, expiresAt);
};

/**
 * Parse a bootstrap `p` query value: base64url-encoded **binary v1** only (see {@link CONNECT_BOOTSTRAP_WIRE_BINARY_V1}).
 */
export const tryParseConnectBootstrapWireString = (rawPayload: string): ConnectBootstrapPayload | null => {
  const bytes = decodeBase64UrlToBytes(rawPayload.trim());

  if (!bytes || bytes[0] !== CONNECT_BOOTSTRAP_WIRE_BINARY_V1) {
    return null;
  }

  return decodeConnectBootstrapWireBinary(bytes);
};
