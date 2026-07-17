/**
 * Host key loading and leaf-certificate minting (ARCHITECTURE.md §3, §8). Reuses
 * `host-certificate.ts` (kept as-is through task 01) for the actual X.509 generation; this module
 * owns key-file hygiene (refusing over-permissive key files) and re-minting the leaf when
 * the advertised address changes so the certificate's SAN stays valid.
 *
 * The SPKI pin is derived from the key's public key alone (`spki-pin.ts`), so it never changes
 * across re-mints — only the certificate's SAN entries do.
 *
 * Opt-in hardening, dev-mode zero-config bootstrap: a *missing* key file is no longer fatal.
 * `createTlsManager` auto-generates one (same material/hygiene as `cordierite keygen`, via
 * `key-material.ts`) so a first-time `cordierite daemon` needs no manual keygen step, and reports
 * the new key's SPKI fingerprint through the optional `warn` callback. An existing key with bad
 * permissions is still refused outright — auto-generation only fills the *missing* case, it never
 * silently replaces a key that's already there.
 */

import { stat, readFile } from "node:fs/promises";

import type { AgentEndpoint } from "@cordierite/shared";

import { generateHostCertificate } from "../host-certificate.js";
import { generatePrivateKeyPem, writePrivateKeyAtomically } from "../key-material.js";
import { getSpkiPinFromPrivateKeyPem } from "../spki-pin.js";
import type { AdvertisedAddress } from "./address.js";

export class HostKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostKeyError";
  }
}

/** Reports informational (non-error) messages, e.g. the fingerprint of an auto-generated key.
 * Deliberately the same shape as `ConfigWarnFn` (`config.ts`) so callers can pass the same
 * function through without an adapter. */
export type TlsWarnFn = (message: string) => void;

/** Refuses a key file that is group/world-readable. Missing files are handled by the caller
 * (`loadOrGenerateHostKeyPem`), which auto-generates instead of throwing. */
export const loadHostKeyPem = async (keyPath: string): Promise<string> => {
  const fileStat = await stat(keyPath);

  if ((fileStat.mode & 0o077) !== 0) {
    throw new HostKeyError(
      `Cordierite host key at "${keyPath}" is group- or world-readable (mode ${(fileStat.mode & 0o777).toString(8)}). ` +
        `Refusing to load it — run "chmod 600 ${keyPath}" or re-run "cordierite keygen".`,
    );
  }

  return readFile(keyPath, "utf8");
};

/**
 * Loads the host key at `keyPath`, generating one in its place if none exists yet (dev-mode
 * zero-config bootstrap). Only the ENOENT case auto-generates: any other `stat`/`readFile` failure
 * (including bad permissions) still propagates as before, so a deliberately hardened/misconfigured
 * key file is never silently overwritten.
 */
export const loadOrGenerateHostKeyPem = async (keyPath: string, warn?: TlsWarnFn): Promise<string> => {
  try {
    return await loadHostKeyPem(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const keyPem = generatePrivateKeyPem();
  await writePrivateKeyAtomically(keyPath, keyPem);
  warn?.(
    `Cordierite: no host key found at "${keyPath}" — generated one (dev mode). ` +
      `SPKI pin: ${getSpkiPinFromPrivateKeyPem(keyPem)}`,
  );

  return keyPem;
};

export type TlsMaterial = {
  certPem: string;
  keyPem: string;
  spkiPin: string;
  advertisedAddress: AdvertisedAddress;
};

export type TlsManager = {
  /** Current cert/key material for the TLS listener. */
  current: () => TlsMaterial;
  /** Re-mints the leaf cert if the advertised address changed; returns the (possibly unchanged) material. */
  refresh: (address?: AdvertisedAddress) => Promise<TlsMaterial>;
  /** SPKI pin-set for `daemon.status`. Single-entry today (no key rotation in v2.0 — ARCHITECTURE.md §14). */
  pinnedKeys: () => string[];
};

export type CreateTlsManagerOptions = {
  keyPath: string;
  detectAddress: () => AdvertisedAddress;
  /** Reports the fingerprint when a missing key is auto-generated (dev-mode bootstrap). */
  warn?: TlsWarnFn;
};

export const createTlsManager = async (options: CreateTlsManagerOptions): Promise<TlsManager> => {
  const keyPem = await loadOrGenerateHostKeyPem(options.keyPath, options.warn);

  const mint = async (address: AdvertisedAddress): Promise<TlsMaterial> => {
    const { certPem, spkiPin } = await generateHostCertificate(keyPem, address.address);
    return { certPem, keyPem, spkiPin, advertisedAddress: address };
  };

  let material = await mint(options.detectAddress());

  return {
    current: () => material,
    refresh: async (address) => {
      const next = address ?? options.detectAddress();

      if (next.address !== material.advertisedAddress.address || next.family !== material.advertisedAddress.family) {
        material = await mint(next);
      }

      return material;
    },
    pinnedKeys: () => [material.spkiPin],
  };
};

export const toAgentEndpoint = (address: AdvertisedAddress, port: number): AgentEndpoint => {
  return { family: address.family, address: address.address, port };
};
