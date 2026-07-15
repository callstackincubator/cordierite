/**
 * Unit tests for advertised-address detection (ARCHITECTURE.md §2/§8). The v1 defect this fixes
 * (`detectHostIp` returning the Docker default-bridge address, `172.17.x.x`) is asserted directly
 * via the exclusion predicates; the full `detectAdvertisedAddress` enumeration itself depends on
 * the machine's real network interfaces, so it is only exercised for the deterministic `override`
 * path here (real-interface selection is covered indirectly by the session-engine integration
 * tests, which always pin `advertisedIp` for determinism).
 */

import { describe, expect, test } from "bun:test";

import { detectAdvertisedAddress, isCgnatIpv4Address, isDockerDefaultBridgeAddress, isExcludedIpv4Address } from "../daemon/address.js";

describe("isDockerDefaultBridgeAddress", () => {
  test("matches the docker0 default bridge range", () => {
    expect(isDockerDefaultBridgeAddress("172.17.0.1")).toBe(true);
    expect(isDockerDefaultBridgeAddress("172.17.255.254")).toBe(true);
  });

  test("does not match other RFC 1918 172.16/12 addresses", () => {
    expect(isDockerDefaultBridgeAddress("172.18.0.1")).toBe(false);
    expect(isDockerDefaultBridgeAddress("172.16.0.1")).toBe(false);
  });
});

describe("isCgnatIpv4Address", () => {
  test("matches the 100.64.0.0/10 shared address space", () => {
    expect(isCgnatIpv4Address("100.64.0.1")).toBe(true);
    expect(isCgnatIpv4Address("100.100.0.1")).toBe(true);
    expect(isCgnatIpv4Address("100.127.255.255")).toBe(true);
  });

  test("does not match addresses outside the range", () => {
    expect(isCgnatIpv4Address("100.63.255.255")).toBe(false);
    expect(isCgnatIpv4Address("100.128.0.0")).toBe(false);
    expect(isCgnatIpv4Address("192.168.1.1")).toBe(false);
  });
});

describe("isExcludedIpv4Address", () => {
  test("excludes both the Docker bridge and CGNAT ranges", () => {
    expect(isExcludedIpv4Address("172.17.0.1")).toBe(true);
    expect(isExcludedIpv4Address("100.64.5.5")).toBe(true);
  });

  test("does not exclude a normal private LAN address", () => {
    expect(isExcludedIpv4Address("192.168.1.10")).toBe(false);
    expect(isExcludedIpv4Address("10.0.0.5")).toBe(false);
  });
});

describe("detectAdvertisedAddress", () => {
  test("an IPv4 override is used verbatim", () => {
    expect(detectAdvertisedAddress({ override: "192.168.1.42" })).toEqual({
      family: 4,
      address: "192.168.1.42",
    });
  });

  test("an IPv6 override is detected by its colons", () => {
    expect(detectAdvertisedAddress({ override: "fd00::1" })).toEqual({
      family: 6,
      address: "fd00::1",
    });
  });
});
