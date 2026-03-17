import { describe, expect, test } from "bun:test";

import type { CordieriteConnectOptions } from "../Cordierite.types";
import type { CordieriteConnectOptionsNative } from "../NativeCordierite";

describe("CordieriteConnectOptions vs CordieriteConnectOptionsNative", () => {
  test("wire shape is assignable both ways for typical payloads", () => {
    const withDevice: CordieriteConnectOptions = {
      ip: "10.0.0.1",
      port: 8443,
      sessionId: "session-abc",
      token: "token-xyz",
      expiresAt: 1_800_000_000,
      deviceManufacturer: "Acme",
      deviceModel: "Phone",
      deviceOs: "OS 1",
    };

    const asNative: CordieriteConnectOptionsNative = withDevice;
    const roundTrip: CordieriteConnectOptions = asNative;
    expect(roundTrip.sessionId).toBe(withDevice.sessionId);
    expect(roundTrip.deviceManufacturer).toBe("Acme");

    const minimalNative: CordieriteConnectOptionsNative = {
      ip: "192.168.1.1",
      port: 443,
      sessionId: "s",
      token: "t",
      expiresAt: 2_000_000_000,
    };
    const asJs: CordieriteConnectOptions = minimalNative;
    expect(asJs.deviceManufacturer).toBeUndefined();
  });
});
