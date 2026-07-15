import type { AddressFamily, AgentEndpoint } from "./transport.js";
import { isValidPort } from "./transport.js";

/** Bootstrap payload version byte (ARCHITECTURE.md §8). The v1 version byte is never accepted. */
export const BOOTSTRAP_VERSION_V2 = 0x02;

const FAMILY_IPV4 = 0x04;
const FAMILY_IPV6 = 0x06;

const TOKEN_BYTES = 32;
const EXPIRES_AT_BYTES = 8;

export type BootstrapPayload = AgentEndpoint & {
  sessionId: string;
  /** Base64url (no padding) encoding of the 32 raw token bytes. */
  token: string;
  /** Unix seconds. */
  expiresAt: number;
};

// --- base64url, no Buffer (Uint8Array/atob/btoa only; the package stays Node-API-free) ---

const decodeBase64UrlToBytes = (input: string): Uint8Array | null => {
  if (input.length === 0 || typeof globalThis.atob !== "function") {
    return null;
  }

  try {
    const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
    const pad = (4 - (normalized.length % 4)) % 4;
    const binary = globalThis.atob(`${normalized}${"=".repeat(pad)}`);
    const out = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }

    return out;
  } catch {
    return null;
  }
};

const encodeBytesToBase64Url = (bytes: Uint8Array): string => {
  if (typeof globalThis.btoa !== "function") {
    throw new Error("Base64 encoding is not available in this runtime.");
  }

  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }

  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/gu, "");
};

// --- IPv4 <-> bytes ---

const ipv4StringToBytes = (ip: string): Uint8Array | null => {
  const parts = ip.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const out = new Uint8Array(4);

  for (let i = 0; i < 4; i++) {
    const x = Number(parts[i]);

    if (!Number.isInteger(x) || x < 0 || x > 255) {
      return null;
    }

    out[i] = x;
  }

  return out;
};

const bytesToIpv4String = (bytes: Uint8Array): string => {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
};

// --- IPv6 <-> bytes ---

const ipv6GroupsToBytes = (groups: string[]): Uint8Array | null => {
  if (groups.length !== 8) {
    return null;
  }

  const out = new Uint8Array(16);

  for (let i = 0; i < 8; i++) {
    const group = groups[i]!;

    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return null;
    }

    const value = Number.parseInt(group, 16);
    out[i * 2] = (value >>> 8) & 0xff;
    out[i * 2 + 1] = value & 0xff;
  }

  return out;
};

const ipv6StringToBytes = (address: string): Uint8Array | null => {
  if (address.length === 0 || address.includes("%")) {
    return null;
  }

  const doubleColonIndex = address.indexOf("::");

  if (doubleColonIndex === -1) {
    return ipv6GroupsToBytes(address.split(":"));
  }

  if (address.indexOf("::", doubleColonIndex + 1) !== -1) {
    // more than one "::" is not a valid IPv6 literal
    return null;
  }

  const head = address.slice(0, doubleColonIndex);
  const tail = address.slice(doubleColonIndex + 2);
  const headParts = head.length > 0 ? head.split(":") : [];
  const tailParts = tail.length > 0 ? tail.split(":") : [];
  const missing = 8 - (headParts.length + tailParts.length);

  if (missing < 0) {
    return null;
  }

  return ipv6GroupsToBytes([...headParts, ...Array<string>(missing).fill("0"), ...tailParts]);
};

const bytesToIpv6String = (bytes: Uint8Array): string => {
  const groups: number[] = [];

  for (let i = 0; i < 8; i++) {
    groups.push((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
  }

  // find the longest run of zero groups (length >= 2) to compress with "::"
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;

  for (let i = 0; i <= groups.length; i++) {
    const isZero = i < groups.length && groups[i] === 0;

    if (isZero) {
      if (runStart === -1) {
        runStart = i;
      }
    } else if (runStart !== -1) {
      const runLen = i - runStart;

      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }

      runStart = -1;
    }
  }

  if (bestLen < 2) {
    return groups.map((g) => g.toString(16)).join(":");
  }

  const before = groups.slice(0, bestStart).map((g) => g.toString(16));
  const after = groups.slice(bestStart + bestLen).map((g) => g.toString(16));

  return `${before.join(":")}::${after.join(":")}`;
};

const addressToBytes = (family: AddressFamily, address: string): Uint8Array | null => {
  return family === FAMILY_IPV4 ? ipv4StringToBytes(address) : ipv6StringToBytes(address);
};

const bytesToAddress = (family: AddressFamily, bytes: Uint8Array): string => {
  return family === FAMILY_IPV4 ? bytesToIpv4String(bytes) : bytesToIpv6String(bytes);
};

// --- big-endian integer helpers ---

const writeU16BE = (view: DataView, offset: number, value: number): void => {
  view.setUint16(offset, value, false);
};

const readU16BE = (view: DataView, offset: number): number => {
  return view.getUint16(offset, false);
};

const writeU64BESeconds = (view: DataView, offset: number, value: number): void => {
  view.setBigUint64(offset, BigInt(value), false);
};

const readU64BESeconds = (view: DataView, offset: number): number => {
  return Number(view.getBigUint64(offset, false));
};

const textEncoder = new TextEncoder();

/**
 * Binary v2 layout → base64url (no padding): `0x02` + family(1) + address(4|16) + port(2) +
 * sessionId(1 + n, UTF-8) + token(32) + expiresAt(8, unix seconds, BE).
 */
export const encodeBootstrap = (payload: BootstrapPayload): string => {
  const tokenBytes = decodeBase64UrlToBytes(payload.token);

  if (!tokenBytes || tokenBytes.length !== TOKEN_BYTES) {
    throw new Error("Cordierite bootstrap token must base64url-decode to exactly 32 bytes.");
  }

  const sessionIdBytes = textEncoder.encode(payload.sessionId);

  if (sessionIdBytes.length === 0 || sessionIdBytes.length > 255) {
    throw new Error("Cordierite bootstrap sessionId must be 1-255 UTF-8 bytes.");
  }

  if (!isValidPort(payload.port)) {
    throw new Error("Cordierite bootstrap has an invalid port.");
  }

  const addressBytes = addressToBytes(payload.family, payload.address);

  if (!addressBytes) {
    throw new Error(`Cordierite bootstrap has an invalid family-${payload.family} address.`);
  }

  const total = 1 + 1 + addressBytes.length + 2 + 1 + sessionIdBytes.length + TOKEN_BYTES + EXPIRES_AT_BYTES;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  bytes[offset++] = BOOTSTRAP_VERSION_V2;
  bytes[offset++] = payload.family === 4 ? FAMILY_IPV4 : FAMILY_IPV6;
  bytes.set(addressBytes, offset);
  offset += addressBytes.length;
  writeU16BE(view, offset, payload.port);
  offset += 2;
  bytes[offset++] = sessionIdBytes.length;
  bytes.set(sessionIdBytes, offset);
  offset += sessionIdBytes.length;
  bytes.set(tokenBytes, offset);
  offset += TOKEN_BYTES;
  writeU64BESeconds(view, offset, payload.expiresAt);

  return encodeBytesToBase64Url(bytes);
};

/**
 * Decodes and strictly validates a base64url bootstrap payload. Rejects: wrong version (including
 * v1's version byte, with no fallback), bad family byte, truncated/oversized buffers (exact
 * total-length check), non-UTF-8 session ids, and port `0`.
 */
export const decodeBootstrap = (b64url: string): BootstrapPayload | null => {
  const bytes = decodeBase64UrlToBytes(b64url);

  if (!bytes || bytes.length < 2) {
    return null;
  }

  if (bytes[0] !== BOOTSTRAP_VERSION_V2) {
    return null;
  }

  const familyByte = bytes[1]!;

  if (familyByte !== FAMILY_IPV4 && familyByte !== FAMILY_IPV6) {
    return null;
  }

  const family: AddressFamily = familyByte === FAMILY_IPV4 ? 4 : 6;
  const addressLen = family === 4 ? 4 : 16;
  const headerLen = 1 + 1 + addressLen + 2;

  if (bytes.length < headerLen + 1) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  const addressBytes = bytes.subarray(offset, offset + addressLen);
  offset += addressLen;

  const port = readU16BE(view, offset);
  offset += 2;

  if (bytes.length <= offset) {
    return null;
  }

  const sessionIdLen = bytes[offset]!;
  offset += 1;

  const totalLen = offset + sessionIdLen + TOKEN_BYTES + EXPIRES_AT_BYTES;

  if (sessionIdLen === 0 || bytes.length !== totalLen) {
    return null;
  }

  const sessionIdBytes = bytes.subarray(offset, offset + sessionIdLen);
  offset += sessionIdLen;

  const tokenBytes = bytes.subarray(offset, offset + TOKEN_BYTES);
  offset += TOKEN_BYTES;

  const expiresAt = readU64BESeconds(view, offset);

  if (!isValidPort(port)) {
    return null;
  }

  let sessionId: string;

  try {
    sessionId = new TextDecoder("utf-8", { fatal: true }).decode(sessionIdBytes);
  } catch {
    return null;
  }

  return {
    family,
    address: bytesToAddress(family, addressBytes),
    port,
    sessionId,
    token: encodeBytesToBase64Url(tokenBytes),
    expiresAt,
  };
};
