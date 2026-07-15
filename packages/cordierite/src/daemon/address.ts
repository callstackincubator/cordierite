/**
 * Advertised-address detection (ARCHITECTURE.md §2, §8 bootstrap endpoint). Prefers a
 * non-internal private IPv4 address, falling back to IPv6, then loopback. Fixes v1's
 * `detectHostIp`, which happily returned a Docker bridge address (`172.17.x.x`, inside the RFC
 * 1918 172.16/12 block v1 treated as "private") — that address is unreachable from a physical
 * device and made the printed deep link useless. Also excludes the IPv4 CGNAT range
 * (`100.64.0.0/10`), which is routable-looking but not device-reachable in the common case.
 */

import { networkInterfaces } from "node:os";

import {
  isLinkLocalIpv6Address,
  isPrivateIpv4Address,
  isUniqueLocalIpv6Address,
  type AddressFamily,
} from "@cordierite/shared";

export type AdvertisedAddress = {
  family: AddressFamily;
  address: string;
};

/** Docker's default bridge network (`docker0`), the exact defect v1 shipped with. */
export const isDockerDefaultBridgeAddress = (address: string): boolean => {
  return address.startsWith("172.17.");
};

/** Carrier-grade NAT shared address space (RFC 6598): `100.64.0.0/10`. */
export const isCgnatIpv4Address = (address: string): boolean => {
  const parts = address.split(".");

  if (parts.length !== 4) {
    return false;
  }

  const first = Number(parts[0]);
  const second = Number(parts[1]);

  return first === 100 && Number.isInteger(second) && second >= 64 && second <= 127;
};

export const isExcludedIpv4Address = (address: string): boolean => {
  return isDockerDefaultBridgeAddress(address) || isCgnatIpv4Address(address);
};

export type DetectAdvertisedAddressOptions = {
  /** Explicit operator override (config or flag); skips interface enumeration entirely. */
  override?: string;
};

/**
 * Enumerates non-internal interface addresses and picks the best advertisable candidate: a
 * private (RFC 1918) IPv4 address first (excluding Docker/CGNAT), then any other non-internal
 * IPv4, then a unique-local (`fd00::/8`) IPv6 address, then any other non-internal, non-link-local
 * IPv6 address, finally falling back to loopback if nothing else is available.
 */
export const detectAdvertisedAddress = (
  options: DetectAdvertisedAddressOptions = {},
): AdvertisedAddress => {
  if (options.override) {
    return {
      family: options.override.includes(":") ? 6 : 4,
      address: options.override,
    };
  }

  const ipv4Candidates: string[] = [];
  const ipv6Candidates: string[] = [];

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) {
        continue;
      }

      if (entry.family === "IPv4") {
        if (isExcludedIpv4Address(entry.address)) {
          continue;
        }

        ipv4Candidates.push(entry.address);
      } else if (entry.family === "IPv6") {
        if (isLinkLocalIpv6Address(entry.address)) {
          continue;
        }

        ipv6Candidates.push(entry.address);
      }
    }
  }

  const preferredIpv4 = ipv4Candidates.find((address) => isPrivateIpv4Address(address)) ?? ipv4Candidates[0];

  if (preferredIpv4) {
    return { family: 4, address: preferredIpv4 };
  }

  const preferredIpv6 =
    ipv6Candidates.find((address) => isUniqueLocalIpv6Address(address)) ?? ipv6Candidates[0];

  if (preferredIpv6) {
    return { family: 6, address: preferredIpv6 };
  }

  return { family: 4, address: "127.0.0.1" };
};
