import { describe, expect, test } from "vitest";

import { toConnectOptions } from "../connect-helpers";
import type { CordieriteBootstrapConnectInput } from "../Cordierite.types";
import type { CreateCordieriteClientOptions } from "../client-types";

const NO_OVERRIDES: CreateCordieriteClientOptions = {};

describe("toConnectOptions", () => {
  test("propagates linkPin from a decoded bootstrap payload (opt-in hardening dev-mode)", () => {
    const input: CordieriteBootstrapConnectInput = {
      family: 4,
      address: "192.168.1.42",
      port: 8443,
      sessionId: "session-123",
      token: "token",
      expiresAt: 1_800_000_000,
      linkPin: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };

    const options = toConnectOptions(input, NO_OVERRIDES);

    expect(options.linkPin).toBe(input.linkPin);
    expect(options.ip).toBe(input.address);
  });

  test("omits linkPin when the bootstrap payload doesn't carry one (old-style links)", () => {
    const input: CordieriteBootstrapConnectInput = {
      family: 4,
      address: "192.168.1.42",
      port: 8443,
      sessionId: "session-123",
      token: "token",
      expiresAt: 1_800_000_000,
    };

    const options = toConnectOptions(input, NO_OVERRIDES);

    expect(options.linkPin).toBeUndefined();
    expect("linkPin" in options).toBe(false);
  });

  test("propagates linkPin from manual CordieriteConnectOptions too", () => {
    const options = toConnectOptions(
      {
        ip: "10.0.0.1",
        port: 8443,
        sessionId: "session-abc",
        token: "token-xyz",
        expiresAt: 1_800_000_000,
        linkPin: "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      },
      NO_OVERRIDES
    );

    expect(options.linkPin).toBe(
      "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="
    );
  });
});
