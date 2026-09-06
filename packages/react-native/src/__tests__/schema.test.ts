import {
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
  type StandardSchemaV1,
} from "@cordierite/shared";
import { describe, expect, test } from "vitest";
import { z as z3 } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { jsonSchema } from "../Cordierite.types";
import {
  exportToolSchema,
  normalizeOptionalToolSchema,
  normalizeToolSchema,
  toToolDescriptor,
  validateToolSchema,
} from "../schema";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

const setDev = (value: boolean): void => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = value;
};

const withDev = <T>(value: boolean, run: () => T): T => {
  const previous = (globalThis as { __DEV__?: boolean }).__DEV__;
  setDev(value);
  try {
    return run();
  } finally {
    (globalThis as { __DEV__?: boolean }).__DEV__ = previous;
  }
};

const success = <T>(value: T): StandardSchemaV1.SuccessResult<T> => ({
  value,
});

/**
 * A real zod 3 schema: it implements `~standard` but has no `~standard.jsonSchema` exporter, which
 * is exactly the shape issue #27 is about. Asserted below rather than assumed.
 */
const zod3Schema = z3.object({ a: z3.number() });

/** A hand-rolled Standard Schema without an exporter (stands in for plain valibot / arktype). */
const shapelessSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => success(value),
  },
};

/**
 * A *callable* Standard Schema. arktype's `Type` is a function object carrying `~standard`, so
 * `typeof` reports `"function"` — detection must not require a plain object.
 */
const callableStandardSchema = (): StandardSchemaV1 => {
  const schema = (value: unknown) => value;
  Object.assign(schema, {
    "~standard": {
      version: 1,
      vendor: "arktype-like",
      validate: (value: unknown) => success(value),
      jsonSchema: {
        input: () => ({ type: "object", title: "callable-in" }),
        output: () => ({ type: "object", title: "callable-out" }),
      },
    },
  });
  return schema as unknown as StandardSchemaV1;
};

const withJsonSchemaExporter = (): StandardSchemaV1 => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => success(value),
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({ type: "object", title: "out" }),
    },
  } as unknown as StandardSchemaV1["~standard"],
});

const withWarningsCaptured = (run: () => void): string[][] => {
  const warnings: string[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String));
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
};

const rawJsonSchema = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
};

describe("zod 3 baseline (the case issue #27 is about)", () => {
  test("zod 3 exposes ~standard.validate but no ~standard.jsonSchema exporter", () => {
    const standard = (zod3Schema as unknown as Record<string, unknown>)[
      "~standard"
    ] as Record<string, unknown>;

    expect(typeof standard.validate).toBe("function");
    expect(standard.jsonSchema).toBeUndefined();
  });
});

describe("normalizeToolSchema: detection matrix", () => {
  test("a Standard Schema is detected as kind 'standard'", () => {
    expect(normalizeToolSchema(zod3Schema, "l")).toEqual({
      kind: "standard",
      schema: zod3Schema,
    });
  });

  test("a { schema, jsonSchema } object pair is detected as kind 'paired'", () => {
    const pair = { schema: zod3Schema, jsonSchema: rawJsonSchema };

    expect(normalizeToolSchema(pair, "l")).toEqual({
      kind: "paired",
      schema: zod3Schema,
      jsonSchema: rawJsonSchema,
    });
  });

  test("a { schema, jsonSchema } converter pair keeps the converter", () => {
    const converter = {
      input: () => ({ type: "object" }),
      output: () => ({ type: "object" }),
    };
    const normalized = normalizeToolSchema(
      { schema: zod3Schema, jsonSchema: converter },
      "l",
    );

    expect(normalized).toEqual({
      kind: "paired",
      schema: zod3Schema,
      jsonSchema: converter,
    });
  });

  test("a callable Standard Schema (the arktype shape) is detected as kind 'standard'", () => {
    const schema = callableStandardSchema();

    expect(typeof schema).toBe("function");
    expect(normalizeToolSchema(schema, "l")).toEqual({
      kind: "standard",
      schema,
    });
  });

  test("a plain object with no ~standard is detected as kind 'raw'", () => {
    expect(normalizeToolSchema(rawJsonSchema, "l")).toEqual({
      kind: "raw",
      jsonSchema: rawJsonSchema,
    });
  });

  test("throws when ~standard is present but not a Standard Schema", () => {
    expect(() => normalizeToolSchema({ "~standard": {} }, "MySchema")).toThrow(
      /must expose "~standard.validate"/,
    );
  });

  test("throws for a pair missing its jsonSchema half", () => {
    expect(() =>
      normalizeToolSchema({ schema: zod3Schema }, "MySchema"),
    ).toThrow(/"jsonSchema" half is not a plain JSON Schema object/);
  });

  test("throws for a pair whose jsonSchema half is a class instance", () => {
    // Held to exactly the same standard as a hand-written raw schema, so the two forms cannot
    // diverge in what they will publish.
    class FakeSchema {
      get type() {
        return "object";
      }
    }

    expect(() =>
      normalizeToolSchema(
        { schema: zod3Schema, jsonSchema: new FakeSchema() },
        "MySchema",
      ),
    ).toThrow(/"jsonSchema" half is not a plain JSON Schema object/);
  });

  test("accepts an empty object as the jsonSchema half of a pair", () => {
    expect(
      normalizeToolSchema({ schema: zod3Schema, jsonSchema: {} }, "l"),
    ).toEqual({ kind: "paired", schema: zod3Schema, jsonSchema: {} });
  });

  test("throws for a pair whose `schema` half is a JSON Schema, not a Standard Schema", () => {
    // The easy mistake: putting JSON Schema in both halves. Silently publishing this object
    // verbatim would make `{ schema: ..., jsonSchema: ... }` the tool's advertised shape.
    expect(() =>
      normalizeToolSchema(
        { schema: { type: "object" }, jsonSchema: rawJsonSchema },
        "MySchema",
      ),
    ).toThrow(/"schema" is missing or is not a Standard Schema/);
  });

  test("throws for a lone `jsonSchema` wrapper with no `schema` half", () => {
    expect(() =>
      normalizeToolSchema({ jsonSchema: rawJsonSchema }, "MySchema"),
    ).toThrow(/"schema" is missing or is not a Standard Schema/);
  });

  test("throws for a validator instance carrying a prototype `type` (yup/joi/superstruct shape)", () => {
    // The regression this rule exists for. A keyword probe using `in` walks the prototype chain,
    // so such an instance would be classified raw and published as the tool's shape — and, holding
    // a circular reference, would then break `JSON.stringify` on the whole registry snapshot, not
    // just this tool.
    class LegacyValidator {
      self: LegacyValidator;

      constructor() {
        this.self = this;
      }

      get type() {
        return "object";
      }
    }
    const instance = new LegacyValidator();

    expect("type" in instance).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(instance, "type")).toBe(false);
    expect(() => JSON.stringify(instance)).toThrow();
    expect(() => normalizeToolSchema(instance, "MySchema")).toThrow(
      /is not a plain JSON Schema object/,
    );
  });

  test("throws for an object whose own `type` is not a JSON Schema type name", () => {
    expect(() => normalizeToolSchema({ type: "banana" }, "MySchema")).toThrow(
      /is not a plain JSON Schema object/,
    );
    expect(() => normalizeToolSchema({ type: 7 }, "MySchema")).toThrow(
      /is not a plain JSON Schema object/,
    );
    expect(() => normalizeToolSchema({ type: [] }, "MySchema")).toThrow(
      /is not a plain JSON Schema object/,
    );
  });

  test("accepts an empty object — the canonical accept-anything JSON Schema", () => {
    expect(normalizeToolSchema({}, "l")).toEqual({
      kind: "raw",
      jsonSchema: {},
    });
  });

  test("accepts a null-prototype object", () => {
    const schema = Object.assign(Object.create(null), { type: "object" });
    expect(normalizeToolSchema(schema, "l").kind).toBe("raw");
  });

  test("accepts schemas built from keywords other than `type`", () => {
    for (const schema of [
      { $defs: { a: { type: "string" } } },
      { required: ["a"] },
      { items: { type: "string" } },
      { not: {} },
      { $ref: "#/$defs/a" },
      { anyOf: [{ type: "string" }] },
      { enum: ["a", "b"] },
      { const: 1 },
      { description: "anything goes" },
    ]) {
      expect(normalizeToolSchema(schema, "l").kind).toBe("raw");
    }
  });

  test("accepts every JSON Schema type name, and an array of them", () => {
    for (const type of [
      "null",
      "boolean",
      "object",
      "array",
      "number",
      "string",
      "integer",
    ]) {
      expect(normalizeToolSchema({ type }, "l").kind).toBe("raw");
    }
    expect(normalizeToolSchema({ type: ["string", "null"] }, "l").kind).toBe(
      "raw",
    );
    expect(() =>
      normalizeToolSchema({ type: ["string", "banana"] }, "MySchema"),
    ).toThrow(/is not a plain JSON Schema object/);
  });

  test("throws for non-objects and arrays", () => {
    expect(() => normalizeToolSchema("nope", "MySchema")).toThrow(TypeError);
    expect(() => normalizeToolSchema(null, "MySchema")).toThrow(TypeError);
    expect(() => normalizeToolSchema([{ type: "object" }], "MySchema")).toThrow(
      TypeError,
    );
  });

  test("normalizeOptionalToolSchema passes undefined through", () => {
    expect(normalizeOptionalToolSchema(undefined, "l")).toBeUndefined();
  });
});

describe("exportToolSchema: Standard Schema with an exporter", () => {
  test("exports the mode-specific JSON Schema and never warns", () => {
    const warnings = withWarningsCaptured(() => {
      const normalized = normalizeToolSchema(withJsonSchemaExporter(), "l");

      expect(exportToolSchema(normalized, "input", "shaped-tool")).toEqual({
        type: "object",
      });
      expect(exportToolSchema(normalized, "output", "shaped-tool")).toEqual({
        type: "object",
        title: "out",
      });
    });

    expect(warnings).toEqual([]);
  });

  test("a callable Standard Schema exports through its ~standard.jsonSchema", () => {
    const normalized = normalizeToolSchema(callableStandardSchema(), "l");

    expect(exportToolSchema(normalized, "input", "callable-tool")).toEqual({
      type: "object",
      title: "callable-in",
    });
    expect(exportToolSchema(normalized, "output", "callable-tool")).toEqual({
      type: "object",
      title: "callable-out",
    });
  });

  test("an exporter that throws is reported, not silently swallowed", () => {
    const throwing = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => success(value),
        jsonSchema: {
          input: () => {
            throw new Error("exporter blew up");
          },
          output: () => ({ type: "object" }),
        },
      },
    };
    const normalized = normalizeToolSchema(throwing, "l");

    expect(() =>
      withDev(true, () =>
        exportToolSchema(normalized, "input", "throwing-tool"),
      ),
    ).toThrow(/exporter blew up/);

    const warnings = withWarningsCaptured(() => {
      withDev(false, () => {
        expect(
          exportToolSchema(normalized, "input", "throwing-prod-tool"),
        ).toBeUndefined();
      });
    });
    expect(
      warnings.some((args) =>
        args.some((arg) => arg.includes("exporter blew up")),
      ),
    ).toBe(true);
  });

  test("an exporter that returns a non-object is reported too", () => {
    const notAnObject = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => success(value),
        jsonSchema: {
          input: () => "not a schema",
          output: () => ({ type: "object" }),
        },
      },
    };

    expect(() =>
      withDev(true, () =>
        exportToolSchema(
          normalizeToolSchema(notAnObject, "l"),
          "input",
          "string-tool",
        ),
      ),
    ).toThrow(/returned string instead of a JSON Schema object/);
  });
});

describe("exportToolSchema: Standard Schema without an exporter", () => {
  test("throws in dev, naming the tool and pointing at the two supported forms", () => {
    const normalized = normalizeToolSchema(zod3Schema, "l");

    expect(() =>
      withDev(true, () => exportToolSchema(normalized, "input", "zod3-tool")),
    ).toThrow(/zod3-tool/);
    expect(() =>
      withDev(true, () => exportToolSchema(normalized, "input", "zod3-tool")),
    ).toThrow(/schema, jsonSchema/);
  });

  test("throws in dev even when no tool name is available", () => {
    expect(() =>
      withDev(true, () =>
        exportToolSchema(normalizeToolSchema(shapelessSchema, "l"), "input"),
      ),
    ).toThrow(TypeError);
  });

  test("outside dev it warns once per tool *and slot*, and registers shapeless", () => {
    const matching = (warnings: string[][], needle: string) =>
      warnings.filter((args) =>
        args.some((arg) => arg.includes(needle) && arg.includes("shapeless")),
      );

    const warnings = withWarningsCaptured(() => {
      withDev(false, () => {
        const normalized = normalizeToolSchema(shapelessSchema, "l");

        expect(
          exportToolSchema(normalized, "input", "prod-tool"),
        ).toBeUndefined();
        expect(
          exportToolSchema(normalized, "output", "prod-tool"),
        ).toBeUndefined();
      });
    });

    // Input and output are two separate things to fix, so both are reported; keying the dedupe on
    // the tool name alone would hide the second.
    expect(matching(warnings, "prod-tool")).toHaveLength(2);
    expect(
      matching(warnings, "prod-tool").filter((args) =>
        args.some((arg) => arg.includes("inputSchema")),
      ),
    ).toHaveLength(1);

    // Re-registering the same tool does not warn again for a slot already reported.
    const repeated = withWarningsCaptured(() => {
      withDev(false, () => {
        const normalized = normalizeToolSchema(shapelessSchema, "l");
        exportToolSchema(normalized, "input", "prod-tool");
        exportToolSchema(normalized, "output", "prod-tool");
      });
    });
    expect(matching(repeated, "prod-tool")).toHaveLength(0);
  });

  test("does not warn or throw when no schema is provided at all", () => {
    const warnings = withWarningsCaptured(() => {
      expect(
        exportToolSchema(undefined, "input", "no-schema-tool"),
      ).toBeUndefined();
    });

    expect(warnings).toEqual([]);
  });
});

describe("exportToolSchema: paired schemas", () => {
  test("a real zod 3 schema paired with zod-to-json-schema publishes a real shape", () => {
    const normalized = normalizeToolSchema(
      {
        schema: zod3Schema,
        jsonSchema: zodToJsonSchema(zod3Schema, {
          target: "jsonSchema2019-09",
        }) as Record<string, unknown>,
      },
      "l",
    );

    const exported = exportToolSchema(normalized, "input", "zod3-paired");

    expect(exported).toMatchObject({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });
  });

  test("a converter pair is called with the draft 2020-12 target, per mode", () => {
    const targets: string[] = [];
    const normalized = normalizeToolSchema(
      {
        schema: zod3Schema,
        jsonSchema: {
          input: (options: { target: string }) => {
            targets.push(options.target);
            return { type: "object", title: "in" };
          },
          output: (options: { target: string }) => {
            targets.push(options.target);
            return { type: "object", title: "out" };
          },
        },
      },
      "l",
    );

    expect(exportToolSchema(normalized, "input", "t")).toEqual({
      type: "object",
      title: "in",
    });
    expect(exportToolSchema(normalized, "output", "t")).toEqual({
      type: "object",
      title: "out",
    });
    expect(targets).toEqual(["draft-2020-12", "draft-2020-12"]);
  });

  test("a paired converter that throws is reported, not silently swallowed", () => {
    // The pair form exists precisely to avoid a shapeless tool, so failing quietly here would put
    // the original bug back for exactly the users who took the documented way out of it.
    const normalized = normalizeToolSchema(
      {
        schema: zod3Schema,
        jsonSchema: {
          input: () => {
            throw new Error("converter blew up");
          },
          output: () => ({ type: "object" }),
        },
      },
      "l",
    );

    expect(() =>
      withDev(true, () => exportToolSchema(normalized, "input", "bad-pair")),
    ).toThrow(/converter blew up/);

    const warnings = withWarningsCaptured(() => {
      withDev(false, () => {
        expect(
          exportToolSchema(normalized, "input", "bad-pair-prod"),
        ).toBeUndefined();
      });
    });
    expect(
      warnings.some((args) =>
        args.some(
          (arg) => arg.includes("bad-pair-prod") && arg.includes("shapeless"),
        ),
      ),
    ).toBe(true);
  });

  test("a paired converter returning a non-object is reported too", () => {
    const normalized = normalizeToolSchema(
      {
        schema: zod3Schema,
        jsonSchema: {
          input: () => [1, 2, 3],
          output: () => ({ type: "object" }),
        },
      },
      "l",
    );

    expect(() =>
      withDev(true, () => exportToolSchema(normalized, "input", "array-pair")),
    ).toThrow(/returned an array instead of a JSON Schema object/);
  });

  test("a paired converter returning a non-plain object is reported too", () => {
    // Converter *results* are held to the same plain-object rule as a hand-written raw schema.
    class FakeSchema {
      get type() {
        return "object";
      }
    }
    const normalized = normalizeToolSchema(
      {
        schema: zod3Schema,
        jsonSchema: {
          input: () => new FakeSchema(),
          output: () => ({ type: "object" }),
        },
      },
      "l",
    );

    expect(() =>
      withDev(true, () =>
        exportToolSchema(normalized, "input", "instance-pair"),
      ),
    ).toThrow(/returned an object that is not plain JSON Schema/);
  });

  test("a converter returning an empty object is accepted", () => {
    const normalized = normalizeToolSchema(
      {
        schema: zod3Schema,
        jsonSchema: { input: () => ({}), output: () => ({}) },
      },
      "l",
    );

    expect(exportToolSchema(normalized, "input", "empty-pair")).toEqual({});
  });

  test("a paired schema never warns or throws in dev", () => {
    const warnings = withWarningsCaptured(() => {
      withDev(true, () => {
        expect(
          exportToolSchema(
            normalizeToolSchema(
              { schema: zod3Schema, jsonSchema: rawJsonSchema },
              "l",
            ),
            "input",
            "paired-tool",
          ),
        ).toEqual(rawJsonSchema);
      });
    });

    expect(warnings).toEqual([]);
  });
});

describe("exportToolSchema: raw JSON Schema", () => {
  test("is published verbatim for both modes, with no warning in dev", () => {
    const warnings = withWarningsCaptured(() => {
      withDev(true, () => {
        const normalized = normalizeToolSchema(rawJsonSchema, "l");

        expect(exportToolSchema(normalized, "input", "raw-tool")).toEqual(
          rawJsonSchema,
        );
        expect(exportToolSchema(normalized, "output", "raw-tool")).toEqual(
          rawJsonSchema,
        );
      });
    });

    expect(warnings).toEqual([]);
  });
});

describe("validateToolSchema", () => {
  test("a zod 3 schema validates through ~standard.validate", async () => {
    const normalized = normalizeToolSchema(zod3Schema, "l");

    await expect(validateToolSchema(normalized, { a: 1 })).resolves.toEqual({
      ok: true,
      value: { a: 1 },
    });

    const failure = await validateToolSchema(normalized, { a: "no" });
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.issues[0]?.path).toEqual(["a"]);
    }
  });

  test("a paired schema validates through its `schema` half", async () => {
    const normalized = normalizeToolSchema(
      { schema: zod3Schema, jsonSchema: rawJsonSchema },
      "l",
    );

    const failure = await validateToolSchema(normalized, { a: "no" });
    expect(failure.ok).toBe(false);
  });

  test("a raw JSON Schema passes every value through unvalidated", async () => {
    const normalized = normalizeToolSchema(rawJsonSchema, "l");

    // Deliberately does not match `rawJsonSchema`: there is no app-side JSON Schema validator.
    await expect(
      validateToolSchema(normalized, { totally: "unrelated" }),
    ).resolves.toEqual({ ok: true, value: { totally: "unrelated" } });
    await expect(validateToolSchema(normalized, 42)).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });
});

describe("toToolDescriptor", () => {
  test("publishes input_schema/output_schema from a raw JSON Schema", () => {
    expect(
      toToolDescriptor({
        name: "raw-registered",
        description: "d",
        inputSchema: normalizeToolSchema(rawJsonSchema, "l"),
        outputSchema: normalizeToolSchema({ type: "string" }, "l"),
      }),
    ).toEqual({
      name: "raw-registered",
      description: "d",
      input_schema: rawJsonSchema,
      output_schema: { type: "string" },
    });
  });

  test("publishes input_schema from a zod 3 + zod-to-json-schema pair", () => {
    const descriptor = toToolDescriptor({
      name: "zod3-registered",
      description: "d",
      inputSchema: normalizeToolSchema(
        {
          schema: zod3Schema,
          jsonSchema: zodToJsonSchema(zod3Schema, {
            target: "jsonSchema2019-09",
          }) as Record<string, unknown>,
        },
        "l",
      ),
    });

    expect(descriptor.input_schema).toMatchObject({
      type: "object",
      properties: { a: { type: "number" } },
    });
    expect(descriptor.output_schema).toBeUndefined();
  });

  test("outside dev a shapeless tool still registers with no schema fields", () => {
    withWarningsCaptured(() => {
      withDev(false, () => {
        expect(
          toToolDescriptor({
            name: "shapeless-registered",
            description: "d",
            inputSchema: normalizeToolSchema(shapelessSchema, "l"),
            outputSchema: normalizeToolSchema(shapelessSchema, "l"),
          }),
        ).toEqual({ name: "shapeless-registered", description: "d" });
      });
    });
  });
});

describe("jsonSchema<T>() helper", () => {
  test("returns the very same object (identity at runtime)", () => {
    const tagged = jsonSchema<{ city: string }>(rawJsonSchema);

    expect(tagged).toBe(rawJsonSchema);
    expect(normalizeToolSchema(tagged, "l")).toEqual({
      kind: "raw",
      jsonSchema: rawJsonSchema,
    });
  });
});

/** A Standard Schema whose JSON Schema exporter returns whatever shape the test needs — stands in
 * for zod's `z.array` / `z.string` / `z.union` exports without pulling zod into this package. */
const withExportedShape = (
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): StandardSchemaV1 => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => success(value),
    jsonSchema: {
      input: () => input,
      output: () => output,
    },
  } as unknown as StandardSchemaV1["~standard"],
});

const objectShape = { type: "object" } as const;

const warningsMentioning = (warnings: string[][], needle: string): string[][] =>
  warnings.filter((args) => args.some((arg) => arg.includes(needle)));

describe("toToolDescriptor: schemas MCP cannot represent (issue #26)", () => {
  test("warns once for a non-object-rooted output schema but still carries the real schema", () => {
    const definition = {
      name: "non-object-output",
      description: "d",
      outputSchema: normalizeToolSchema(
        withExportedShape(objectShape, {
          type: "array",
          items: { type: "string" },
        }),
        "l",
      ),
    };

    const warnings = withWarningsCaptured(() => {
      const first = toToolDescriptor(definition);
      const second = toToolDescriptor(definition);

      // The descriptor is unchanged: the CLI, the JS client and app-side result validation all
      // keep the real schema; only the MCP surface degrades.
      expect(first.output_schema).toEqual({
        type: "array",
        items: { type: "string" },
      });
      expect(second.output_schema).toEqual({
        type: "array",
        items: { type: "string" },
      });
    });

    const relevant = warningsMentioning(warnings, "non-object-output");
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.join(" ")).toContain("output");
    expect(relevant[0]!.join(" ")).toContain("no schema describing it");
  });

  test("warns once for a non-object-rooted input schema", () => {
    const warnings = withWarningsCaptured(() => {
      const descriptor = toToolDescriptor({
        name: "non-object-input",
        description: "d",
        inputSchema: normalizeToolSchema(
          withExportedShape({ type: "string" }, objectShape),
          "l",
        ),
      });

      expect(descriptor.input_schema).toEqual({ type: "string" });
    });

    const relevant = warningsMentioning(warnings, "non-object-input");
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.join(" ")).toContain("input");
  });

  test.each([
    ["union-output", "anyOf"],
    ["discriminated-union-output", "oneOf"],
    ["intersection-output", "allOf"],
  ])(
    "a %s export (%s, no root type) warns even though every branch is an object",
    (toolName, keyword) => {
      const warnings = withWarningsCaptured(() => {
        toToolDescriptor({
          name: toolName,
          description: "d",
          outputSchema: normalizeToolSchema(
            withExportedShape(objectShape, {
              [keyword]: [{ type: "object" }, { type: "object" }],
            }),
            "l",
          ),
        });
      });

      expect(warningsMentioning(warnings, toolName)).toHaveLength(1);
    },
  );

  test("stays silent for object-rooted schemas on both sides", () => {
    const warnings = withWarningsCaptured(() => {
      toToolDescriptor({
        name: "object-both-sides",
        description: "d",
        inputSchema: normalizeToolSchema(
          withExportedShape(objectShape, objectShape),
          "l",
        ),
        outputSchema: normalizeToolSchema(
          withExportedShape(objectShape, {
            type: "object",
            properties: { echoed: { type: "string" } },
          }),
          "l",
        ),
      });
    });

    expect(warningsMentioning(warnings, "object-both-sides")).toEqual([]);
  });

  test("a shapeless schema (outside dev) warns only about the missing exporter, not about object-rootedness", () => {
    const warnings = withWarningsCaptured(() => {
      withDev(false, () =>
        toToolDescriptor({
          name: "shapeless-not-double-warned",
          description: "d",
          outputSchema: normalizeToolSchema(shapelessSchema, "l"),
        }),
      );
    });

    const relevant = warningsMentioning(
      warnings,
      "shapeless-not-double-warned",
    );
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.join(" ")).toContain("shapeless");
  });
});

describe("toToolDescriptor: timeout_ms", () => {
  test("carries an explicitly declared timeoutMs onto the wire descriptor as timeout_ms", () => {
    const descriptor = toToolDescriptor({
      name: "slow-tool",
      description: "d",
      timeoutMs: 60_000,
    });

    // The registration option is camelCase; the wire field is snake_case like every other
    // protocol-defined descriptor field.
    expect(descriptor).toEqual({
      name: "slow-tool",
      description: "d",
      timeout_ms: 60_000,
    });
  });

  test.each([
    ["below the minimum", 500, MIN_TOOL_TIMEOUT_MS],
    ["zero", 0, MIN_TOOL_TIMEOUT_MS],
    ["negative", -1, MIN_TOOL_TIMEOUT_MS],
    ["above the maximum", 900_000, MAX_TOOL_TIMEOUT_MS],
    ["fractional", 1500.5, 1500],
  ])(
    "clamps a timeoutMs %s into the range the daemon enforces, with a dev warning",
    (_label, timeoutMs, expected) => {
      const warnings = withWarningsCaptured(() => {
        const descriptor = toToolDescriptor({
          name: `clamped-${String(timeoutMs)}`,
          description: "d",
          timeoutMs,
        });

        // Sending the raw value would leave the app's abort timer and the daemon's call timer
        // disagreeing about when this tool is out of time.
        expect(descriptor.timeout_ms).toBe(expected);
      });

      expect(
        warnings.some((args) => args.some((arg) => arg.includes("timeoutMs"))),
      ).toBe(true);
    },
  );

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "drops a timeoutMs that is %s, with a dev warning, rather than sending a descriptor the daemon rejects",
    (_label, timeoutMs) => {
      const warnings = withWarningsCaptured(() => {
        const descriptor = toToolDescriptor({
          name: `unclampable-${String(timeoutMs)}`,
          description: "d",
          timeoutMs,
        });

        // `isToolDescriptor` rejects the whole registry snapshot over one bad field, so emitting
        // this would close the session instead of degrading to the daemon's default.
        expect("timeout_ms" in descriptor).toBe(false);
      });

      expect(
        warnings.some((args) => args.some((arg) => arg.includes("timeoutMs"))),
      ).toBe(true);
    },
  );

  test("warns only once per tool name, like the shapeless-schema warning", () => {
    const warnings = withWarningsCaptured(() => {
      toToolDescriptor({
        name: "noisy-timeout",
        description: "d",
        timeoutMs: 5,
      });
      toToolDescriptor({
        name: "noisy-timeout",
        description: "d",
        timeoutMs: 5,
      });
    });

    expect(
      warnings.filter((args) =>
        args.some((arg) => arg.includes("noisy-timeout")),
      ),
    ).toHaveLength(1);
  });

  test("omits the key entirely when the tool declares no timeout", () => {
    const descriptor = toToolDescriptor({
      name: "plain-tool",
      description: "d",
    });

    // Not merely `undefined`: the key must be absent so the frame never carries
    // `"timeoutMs": undefined` and the daemon keeps its own default.
    expect("timeout_ms" in descriptor).toBe(false);
    expect(Object.keys(descriptor)).toEqual(["name", "description"]);
  });
});
