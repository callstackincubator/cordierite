/**
 * Host key loading and leaf-certificate minting (ARCHITECTURE.md §3, §8). Reuses
 * `host-certificate.ts` (kept as-is through task 01) for the actual X.509 generation; this module
 * owns key-file hygiene (refusing missing/over-permissive key files) and re-minting the leaf when
 * the advertised address changes so the certificate's SAN stays valid.
 *
 * The SPKI pin is derived from the key's public key alone (`spki-pin.ts`), so it never changes
 * across re-mints — only the certificate's SAN entries do.
 */

import { stat, readFile } from "node:fs/promises";

import type { AgentEndpoint } from "@cordierite/shared";

import { generateHostCertificate } from "../host-certificate.js";
import type { AdvertisedAddress } from "./address.js";

export class HostKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostKeyError";
  }
}

/** Refuses a missing key file (pointing at `cordierite keygen`) or one that is group/world-readable. */
export const loadHostKeyPem = async (keyPath: string): Promise<string> => {
  let fileStat: Awaited<ReturnType<typeof stat>>;

  try {
    fileStat = await stat(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HostKeyError(
        `Cordierite host key not found at "${keyPath}". Run "cordierite keygen" to create one.`,
      );
    }

    throw error;
  }

  if ((fileStat.mode & 0o077) !== 0) {
    throw new HostKeyError(
      `Cordierite host key at "${keyPath}" is group- or world-readable (mode ${(fileStat.mode & 0o777).toString(8)}). ` +
        `Refusing to load it — run "chmod 600 ${keyPath}" or re-run "cordierite keygen".`,
    );
  }

  return readFile(keyPath, "utf8");
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
};

export const createTlsManager = async (options: CreateTlsManagerOptions): Promise<TlsManager> => {
  const keyPem = await loadHostKeyPem(options.keyPath);

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
