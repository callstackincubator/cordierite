/**
 * Type-level regression guard for issue #27: widening what `inputSchema`/`outputSchema` accept
 * must not weaken handler argument/result inference for the forms that already worked (zod 4),
 * and must give the new forms real types too.
 *
 * The enforcement here is `tsc` (`pnpm typecheck` / `pnpm build`), not Vitest — `exactType` is
 * invariant, so a handler argument that is even slightly wider or narrower than the expected type
 * fails to compile. The single runtime assertion exists only so the file is a real test.
 */
import { describe, expect, test, vi } from "vitest";
import { z as z3 } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z as z4 } from "zod4";

import type {
  CordieriteRuntimeSchema,
  InferToolArgs,
  InferToolResult,
} from "../Cordierite.types";
import { jsonSchema } from "../Cordierite.types";
import type { CordierePublicApi } from "../public-api";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

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

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when `A` is *exactly* `Expected` — not merely assignable in either direction. */
const exactType =
  <Expected>() =>
  <A>(
    _value: A & (Equals<A, Expected> extends true ? unknown : never),
  ): void => {};

describe("handler inference across every accepted schema form (issue #27)", () => {
  test("compiles against the shared public API type", async () => {
    const { registerTool } = (await import("../noop")) as Pick<
      CordierePublicApi,
      "registerTool"
    >;

    // zod 4: unchanged behaviour — the schema's own output type, via `~standard`.
    registerTool({
      name: "zod4",
      description: "d",
      inputSchema: z4.object({ a: z4.number(), b: z4.string() }),
      outputSchema: z4.object({ total: z4.number() }),
      handler: (args) => {
        exactType<{ a: number; b: string }>()(args);
        return { total: args.a };
      },
    }).remove();

    // zod 3 paired with an explicit JSON Schema: same inference as zod 4.
    const zod3Input = z3.object({ a: z3.number() });
    const zod3Output = z3.object({ total: z3.number() });
    registerTool({
      name: "zod3-paired",
      description: "d",
      inputSchema: {
        schema: zod3Input,
        jsonSchema: zodToJsonSchema(zod3Input) as Record<string, unknown>,
      },
      outputSchema: {
        schema: zod3Output,
        jsonSchema: zodToJsonSchema(zod3Output) as Record<string, unknown>,
      },
      handler: (args) => {
        exactType<{ a: number }>()(args);
        return { total: args.a };
      },
    }).remove();

    // A bare raw JSON Schema: no type information to recover, so `Record<string, unknown>`.
    registerTool({
      name: "raw-bare",
      description: "d",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
      handler: (args) => {
        exactType<Record<string, unknown>>()(args);
      },
    }).remove();

    // `jsonSchema<T>()` carries the caller's declared type into the handler.
    registerTool({
      name: "raw-typed",
      description: "d",
      inputSchema: jsonSchema<{ city: string }>({ type: "object" }),
      outputSchema: jsonSchema<{ temp: number }>({ type: "object" }),
      handler: (args) => {
        exactType<{ city: string }>()(args);
        return { temp: args.city.length };
      },
    }).remove();

    expect(true).toBe(true);
  });

  test("an explicitly annotated CordieriteRuntimeSchema<T> stays exactly T", async () => {
    const { registerTool } = await import("../noop");

    // Annotating the schema (rather than letting it be inferred from the value) must not widen the
    // handler argument: every member of the union — Standard Schema, pair, and raw — carries the
    // annotation's own type, so the raw member cannot leak `Record<string, unknown>` back in.
    const annotated: CordieriteRuntimeSchema<{ a: number }> = z4.object({
      a: z4.number(),
    });

    registerTool({
      name: "annotated",
      description: "d",
      inputSchema: annotated,
      outputSchema: annotated,
      handler: (args) => {
        exactType<{ a: number }>()(args);
        return { a: args.a };
      },
    }).remove();

    // The same annotation satisfied by a raw JSON Schema rather than a Standard Schema.
    const annotatedRaw: CordieriteRuntimeSchema<{ a: number }> = jsonSchema<{
      a: number;
    }>({ type: "object", properties: { a: { type: "number" } } });

    registerTool({
      name: "annotated-raw",
      description: "d",
      inputSchema: annotatedRaw,
      handler: (args) => {
        exactType<{ a: number }>()(args);
      },
    }).remove();

    expect(true).toBe(true);
  });

  test("a two-parameter CordieriteRuntimeSchema<In, Out> keeps the sides apart", async () => {
    const { registerTool } = await import("../noop");

    // With distinct input and output types the two sides must not collapse into `In | Out`: an
    // `inputSchema` handler receives the *output* (post-validation) type, an `outputSchema` handler
    // returns the *input* (pre-validation) one. A raw member carrying a single phantom slot would
    // widen both to the union.
    const coercing: CordieriteRuntimeSchema<string, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value: Number(value) }),
      },
    } as CordieriteRuntimeSchema<string, number>;

    registerTool({
      name: "two-param-input",
      description: "d",
      inputSchema: coercing,
      handler: (args) => {
        exactType<number>()(args);
      },
    }).remove();

    registerTool({
      name: "two-param-output",
      description: "d",
      outputSchema: coercing,
      handler: () => {
        return "42";
      },
    }).remove();

    // `registerTool` above only proves the handler's return is *assignable*; these assert the two
    // sides are exactly `number` and `string`, so a collapse to `string | number` fails to compile.
    exactType<number>()(null as unknown as InferToolArgs<typeof coercing>);
    exactType<string>()(null as unknown as InferToolResult<typeof coercing>);

    // Same annotation, satisfied by a raw JSON Schema rather than a Standard Schema.
    const coercingRaw = {} as CordieriteRuntimeSchema<string, number>;

    registerTool({
      name: "two-param-raw-input",
      description: "d",
      inputSchema: coercingRaw,
      handler: (args) => {
        exactType<number>()(args);
      },
    }).remove();

    registerTool({
      name: "two-param-raw-output",
      description: "d",
      outputSchema: coercingRaw,
      handler: () => {
        return "42";
      },
    }).remove();

    exactType<number>()(null as unknown as InferToolArgs<typeof coercingRaw>);
    exactType<string>()(null as unknown as InferToolResult<typeof coercingRaw>);

    expect(true).toBe(true);
  });
});
