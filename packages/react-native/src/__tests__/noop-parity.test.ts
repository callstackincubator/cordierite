import { describe, expect, vi, test } from "vitest";
import { z as z3 } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { CordieriteDisabledError } from "../Cordierite.types";
import type { CordierePublicApi } from "../public-api";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/** Compile-time assertion that `value` is exactly `T` (invariant, so a widened arg type fails). */
const expectType = <T>(value: T): T => value;

// The root (`.`) entry pulls in `react-native` (for `AppState`/`Linking`), whose own source cannot
// be parsed under a Node test runner (Flow-typed; see `deep-link-install.test.ts`); `./noop` never
// touches `react-native` at all, but this file imports both entries side by side, so the mock is
// needed regardless.
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove() {} }),
  },
  Linking: {
    getInitialURL: () => Promise.resolve(null),
    addEventListener: () => ({ remove() {} }),
  },
}));

describe("noop parity: type-level (see also public-api.ts's doc comment)", () => {
  test("both entries structurally satisfy CordierePublicApi", async () => {
    const realModule = await import("../index");
    const noopModule = await import("../noop");

    // The meaningful check here is `tsc` (`pnpm run build`) accepting these two assignments —
    // Vitest strips types at runtime, so this is a signpost for the reader, not the enforcement,
    // mirroring
    // `connect-options-parity.test.ts`'s pattern.
    const realSatisfiesPublicApi: CordierePublicApi = realModule;
    const noopSatisfiesPublicApi: CordierePublicApi = noopModule;

    const names: (keyof CordierePublicApi)[] = [
      "registerTool",
      "useCordieriteTool",
      "jsonSchema",
      "postEvent",
      "getRegisteredTools",
      "addCordieriteListener",
      "restoreSession",
      "getCordieriteState",
      "connect",
      "getCordieriteBuildConfig",
    ];
    for (const name of names) {
      expect(typeof realSatisfiesPublicApi[name]).toBe("function");
      expect(typeof noopSatisfiesPublicApi[name]).toBe("function");
    }
  });

  test("every accepted schema form compiles identically against both entries (issue #27)", async () => {
    const realModule = await import("../index");
    const noopModule = await import("../noop");

    const rawSchema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    const zod3Input = z3.object({ a: z3.number() });
    const pairedSchema = {
      schema: zod3Input,
      jsonSchema: zodToJsonSchema(zod3Input) as Record<string, unknown>,
    };

    // As with the assignments above, the real enforcement is `tsc`: each of these registrations
    // must type-check against BOTH entries, and each `handler` must receive the inferred argument
    // type — a bare raw schema gives `Record<string, unknown>`, `jsonSchema<T>()` gives `T`, and a
    // pair gives the Standard Schema's own output type.
    const registrars: CordierePublicApi["registerTool"][] = [
      realModule.registerTool,
      noopModule.registerTool,
    ];

    for (const registerTool of registrars) {
      registerTool({
        name: "raw-bare",
        description: "d",
        inputSchema: rawSchema,
        handler: (args) => {
          expectType<Record<string, unknown>>(args);
        },
      }).remove();

      registerTool({
        name: "raw-typed",
        description: "d",
        inputSchema: noopModule.jsonSchema<{ city: string }>(rawSchema),
        handler: (args) => {
          expectType<{ city: string }>(args);
        },
      }).remove();

      registerTool({
        name: "paired",
        description: "d",
        inputSchema: pairedSchema,
        handler: (args) => {
          expectType<{ a: number }>(args);
        },
      }).remove();
    }

    // `jsonSchema` is the same identity helper on both entries.
    expect(realModule.jsonSchema(rawSchema)).toBe(rawSchema);
    expect(noopModule.jsonSchema(rawSchema)).toBe(rawSchema);
  });

  test("useCordieriteTool takes the same (definition, deps, options) arity on both entries", async () => {
    const realModule = await import("../index");
    const noopModule = await import("../noop");

    // `CordierePublicApi` alone would not catch one entry silently dropping the third `options`
    // parameter — TS structurally accepts a function with fewer parameters where more are
    // expected, so `{ enabled }` support could drift without this failing at the type level.
    // Both entries build `useCordieriteTool` from the same `createUseCordieriteTool` factory
    // (see `useCordieriteTool.ts`), so this asserts that invariant holds rather than merely
    // hoping it does — `.length` reflects the function's declared (non-rest, non-default)
    // parameter count at runtime.
    expect(realModule.useCordieriteTool.length).toBe(
      noopModule.useCordieriteTool.length,
    );
    expect(realModule.useCordieriteTool.length).toBe(3);
  });
});

describe("noop entry: runtime no-op behavior", () => {
  test("registerTool returns a disposer but registers nothing observable", async () => {
    const { registerTool } = await import("../noop");

    const registration = registerTool({
      name: "any-tool",
      description: "d",
      handler: () => "result",
    });

    expect(typeof registration.remove).toBe("function");
    expect(() => registration.remove()).not.toThrow();
  });

  test("postEvent resolves without doing anything", async () => {
    const { postEvent } = await import("../noop");
    await expect(postEvent("anything", { a: 1 })).resolves.toBeUndefined();
  });

  test("addCordieriteListener returns a disposer; the callback never fires", async () => {
    const { addCordieriteListener } = await import("../noop");
    let fired = false;

    const subscription = addCordieriteListener("stateChange", () => {
      fired = true;
    });

    expect(fired).toBe(false);
    expect(() => subscription.remove()).not.toThrow();
  });

  test("getRegisteredTools() always returns an empty array, even after registerTool", async () => {
    const { registerTool, getRegisteredTools } = await import("../noop");

    registerTool({
      name: "any-tool",
      description: "d",
      handler: () => "result",
    });

    expect(getRegisteredTools()).toEqual([]);
  });

  test("restoreSession() always resolves false (no native lease exists)", async () => {
    const { restoreSession } = await import("../noop");
    await expect(restoreSession()).resolves.toBe(false);
  });

  test('getCordieriteState() always returns "idle"', async () => {
    const { getCordieriteState } = await import("../noop");
    expect(getCordieriteState()).toBe("idle");
  });

  test('getCordieriteBuildConfig() reports the documented "absent" shape', async () => {
    const { getCordieriteBuildConfig } = await import("../noop");

    expect(getCordieriteBuildConfig()).toEqual({
      trust: "absent",
      hasEmbeddedPins: false,
      allowPrivateLanOnly: true,
    });
  });

  test("connect() rejects with a CordieriteDisabledError (code: cordierite_disabled)", async () => {
    const { connect } = await import("../noop");

    await expect(
      connect({
        ip: "127.0.0.1",
        port: 8443,
        sessionId: "s",
        token: "a".repeat(43),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    ).rejects.toThrow(CordieriteDisabledError);

    try {
      await connect({
        ip: "127.0.0.1",
        port: 8443,
        sessionId: "s",
        token: "a".repeat(43),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });
      throw new Error("expected connect() to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CordieriteDisabledError);
      expect((error as CordieriteDisabledError).code).toBe(
        "cordierite_disabled",
      );
    }
  });
});
