import { encodeBootstrap, type BootstrapPayload } from "@cordierite/shared";
import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import type { CordieriteConnectionState } from "../Cordierite.types";
import {
  __cordieriteResetDeepLinkBootstrapForTests,
  addCordieriteErrorListener,
  handleCordieriteDeepLinkUrl,
  hasCordieriteBootstrapQuery,
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

const createMockClient = (initialState: CordieriteConnectionState = "idle") => {
  let state = initialState;
  const connects: unknown[] = [];
  return {
    connects,
    setState(s: CordieriteConnectionState) {
      state = s;
    },
    getState() {
      return state;
    },
    async connect(input: unknown) {
      connects.push(input);
    },
  };
};

describe("cordierite deep-link bootstrap", () => {
  beforeEach(() => {
    __cordieriteResetDeepLinkBootstrapForTests();
  });

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

  test("handleCordieriteDeepLinkUrl skips when already connecting or active", () => {
    for (const state of ["connecting", "active"] as const) {
      const client = createMockClient(state);
      handleCordieriteDeepLinkUrl(client, bootstrapUrl(basePayload), {
        now: FIXED_NOW,
      });
      expect(client.connects).toEqual([]);
    }
  });

  test("handleCordieriteDeepLinkUrl notifies error listeners on bad payload", () => {
    const client = createMockClient();
    const events: { phase: string }[] = [];
    const sub = addCordieriteErrorListener((e) => {
      events.push({ phase: e.phase });
    });
    handleCordieriteDeepLinkUrl(client, "playground:///?cordierite=not-valid", {
      now: FIXED_NOW,
    });
    expect(events).toEqual([{ phase: "parse" }]);
    sub.remove();
  });

  test("handleCordieriteDeepLinkUrl notifies error listeners when connect rejects", async () => {
    const client = {
      getState: (): CordieriteConnectionState => "idle",
      async connect() {
        throw new Error("native failed");
      },
    };
    const phases: string[] = [];
    addCordieriteErrorListener((e) => {
      phases.push(e.phase);
    });
    handleCordieriteDeepLinkUrl(client, bootstrapUrl(basePayload), {
      now: FIXED_NOW,
    });
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(phases).toEqual(["connect"]);
  });
});
