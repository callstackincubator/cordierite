import { encodeBootstrap, type BootstrapPayload } from "@cordierite/shared";
import { describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";

import type { CordieriteConnectionState } from "../Cordierite.types";
import {
  handleCordieriteDeepLinkUrl,
  hasCordieriteBootstrapQuery,
  type CordieriteAutoBootstrapClient,
} from "../deep-link-core";

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/gu, "");
};

const token32B64Url = (): string =>
  bytesToBase64Url(new Uint8Array(randomBytes(32)));

const FIXED_NOW = 1_710_000_000;

const basePayload: BootstrapPayload = {
  family: 4,
  address: "192.168.1.42",
  port: 8443,
  sessionId: "session-123",
  token: token32B64Url(),
  expiresAt: FIXED_NOW + 30,
};

const bootstrapUrl = (p: BootstrapPayload) =>
  `playground:///?cordierite=${encodeBootstrap(p)}`;

const createMockClient = (
  initialState: CordieriteConnectionState = "idle",
  initialSessionId: string | null = null,
): CordieriteAutoBootstrapClient & {
  connects: unknown[];
  supersedes: (boolean | undefined)[];
  bootstrapErrors: { phase: "parse" | "connect"; error: unknown }[];
  setState(s: CordieriteConnectionState): void;
} => {
  let state = initialState;
  const connects: unknown[] = [];
  const supersedes: (boolean | undefined)[] = [];
  const bootstrapErrors: { phase: "parse" | "connect"; error: unknown }[] = [];

  return {
    connects,
    supersedes,
    bootstrapErrors,
    restoreSession: async () => false,
    setState(s: CordieriteConnectionState) {
      state = s;
    },
    getState() {
      return state;
    },
    getSessionId() {
      return initialSessionId;
    },
    async connect(input: unknown, options) {
      connects.push(input);
      supersedes.push(options?.supersede);
    },
    reportBootstrapError(event) {
      bootstrapErrors.push(event);
    },
  };
};

describe("cordierite deep-link bootstrap", () => {
  test("hasCordieriteBootstrapQuery is false without param", () => {
    expect(hasCordieriteBootstrapQuery("myapp://some/path")).toBe(false);
    expect(hasCordieriteBootstrapQuery(null)).toBe(false);
  });

  test("hasCordieriteBootstrapQuery is true with cordierite param", () => {
    expect(hasCordieriteBootstrapQuery("playground:///?cordierite=abc")).toBe(
      true
    );
  });

  test("handleCordieriteDeepLinkUrl ignores unrelated URLs", () => {
    const client = createMockClient();
    handleCordieriteDeepLinkUrl(client, "playground://tabs/home");
    expect(client.connects).toEqual([]);
  });

  test("handleCordieriteDeepLinkUrl connects when idle and URL is valid", () => {
    const client = createMockClient("idle");
    const url = bootstrapUrl(basePayload);
    handleCordieriteDeepLinkUrl(client, url, {
      now: FIXED_NOW,
      requirePrivateIp: true,
    });
    expect(client.connects).toHaveLength(1);
    expect(client.connects[0]).toMatchObject({
      address: basePayload.address,
      port: basePayload.port,
      sessionId: basePayload.sessionId,
    });
  });

  test("handleCordieriteDeepLinkUrl accepts loopback when local-only validation is enabled", () => {
    const client = createMockClient("idle");
    const url = bootstrapUrl({ ...basePayload, address: "127.0.0.1" });
    handleCordieriteDeepLinkUrl(client, url, {
      now: FIXED_NOW,
      requirePrivateIp: true,
    });
    expect(client.connects).toHaveLength(1);
    expect(client.connects[0]).toMatchObject({
      address: "127.0.0.1",
      port: basePayload.port,
      sessionId: basePayload.sessionId,
    });
  });

  test("handleCordieriteDeepLinkUrl rejects a non-private address when requirePrivateIp defaults on", () => {
    const client = createMockClient("idle");
    const url = bootstrapUrl({ ...basePayload, address: "8.8.8.8" });
    handleCordieriteDeepLinkUrl(client, url, { now: FIXED_NOW });
    expect(client.connects).toEqual([]);
    expect(client.bootstrapErrors).toEqual([
      { phase: "parse", error: expect.anything() },
    ]);
  });

  test("handleCordieriteDeepLinkUrl allows a non-private address when requirePrivateIp is explicitly disabled", () => {
    const client = createMockClient("idle");
    const url = bootstrapUrl({ ...basePayload, address: "8.8.8.8" });
    handleCordieriteDeepLinkUrl(client, url, {
      now: FIXED_NOW,
      requirePrivateIp: false,
    });
    expect(client.connects).toHaveLength(1);
  });

  test("a link for a different session supersedes one already connecting or active", () => {
    // The old behavior — ignoring the link outright — left the operator's freshly minted session
    // unclaimed with nothing logged anywhere, so `wait_for_session` just ran out its timeout.
    for (const state of ["connecting", "active"] as const) {
      const client = createMockClient(state, "some-other-session");
      handleCordieriteDeepLinkUrl(client, bootstrapUrl(basePayload), {
        now: FIXED_NOW,
      });
      expect(client.connects).toHaveLength(1);
      expect(client.supersedes).toEqual([true]);
    }
  });

  test("a link for the session already held is ignored, not re-claimed", () => {
    // Its token is single-use: the daemon answers a second claim with a terminal
    // `1008 already_claimed`, so tearing down to re-claim would leave the app with no session at
    // all. The same link can legitimately arrive twice (getInitialURL overlapping the url event).
    for (const state of ["connecting", "active"] as const) {
      const client = createMockClient(state, basePayload.sessionId);
      handleCordieriteDeepLinkUrl(client, bootstrapUrl(basePayload), {
        now: FIXED_NOW,
      });
      expect(client.connects).toEqual([]);
      expect(client.bootstrapErrors).toEqual([]);
    }
  });

  test("connecting to a fresh session from idle does not ask to supersede", () => {
    const client = createMockClient("idle");
    handleCordieriteDeepLinkUrl(client, bootstrapUrl(basePayload), {
      now: FIXED_NOW,
    });
    expect(client.supersedes).toEqual([false]);
  });

  test("an invalid link never tears down a live session", () => {
    // Parse/validate strictly precedes any teardown decision — otherwise a malformed or expired
    // link becomes a free way to kill a working session.
    const client = createMockClient("active", "held-session");

    handleCordieriteDeepLinkUrl(client, "playground:///?cordierite=not-valid", {
      now: FIXED_NOW,
    });
    handleCordieriteDeepLinkUrl(
      client,
      bootstrapUrl({ ...basePayload, expiresAt: FIXED_NOW - 1 }),
      { now: FIXED_NOW }
    );

    expect(client.connects).toEqual([]);
    expect(client.bootstrapErrors.map((entry) => entry.phase)).toEqual([
      "parse",
      "parse",
    ]);
  });

  test("handleCordieriteDeepLinkUrl reports a parse-phase bootstrap error on bad payload", () => {
    const client = createMockClient();
    handleCordieriteDeepLinkUrl(client, "playground:///?cordierite=not-valid", {
      now: FIXED_NOW,
    });
    expect(client.bootstrapErrors).toEqual([
      { phase: "parse", error: expect.anything() },
    ]);
  });

  test("handleCordieriteDeepLinkUrl reports a connect-phase bootstrap error when connect rejects", async () => {
    const bootstrapErrors: { phase: "parse" | "connect"; error: unknown }[] =
      [];
    const client: CordieriteAutoBootstrapClient = {
      restoreSession: async () => false,
      getState: (): CordieriteConnectionState => "idle",
      getSessionId: () => null,
      async connect() {
        throw new Error("native failed");
      },
      reportBootstrapError(event) {
        bootstrapErrors.push(event);
      },
    };
    handleCordieriteDeepLinkUrl(client, bootstrapUrl(basePayload), {
      now: FIXED_NOW,
    });
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(bootstrapErrors).toEqual([
      { phase: "connect", error: expect.anything() },
    ]);
  });

  test("handleCordieriteDeepLinkUrl reports a bootstrap error (not a throw) when getState() throws", () => {
    // Regression test for the v1 defect: getState() was called before any guard, which crashed on
    // the web stub (getState used to throw there). The fix is two-layered: CordieriteModule.web.ts
    // now returns "idle" instead of throwing, and handleCordieriteDeepLinkUrl defensively catches
    // any client whose getState() still throws and reports it instead of propagating.
    const client: CordieriteAutoBootstrapClient = {
      restoreSession: async () => false,
      getState() {
        throw new Error("getState is not available on this platform");
      },
      getSessionId: () => null,
      connect: async () => {},
      reportBootstrapError: () => {},
    };
    const bootstrapErrors: { phase: "parse" | "connect"; error: unknown }[] =
      [];
    client.reportBootstrapError = (event) => {
      bootstrapErrors.push(event);
    };

    expect(() => {
      handleCordieriteDeepLinkUrl(client, bootstrapUrl(basePayload), {
        now: FIXED_NOW,
      });
    }).not.toThrow();
    expect(bootstrapErrors).toHaveLength(1);
  });
});
