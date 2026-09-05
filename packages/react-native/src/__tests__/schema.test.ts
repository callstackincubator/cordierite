import type { StandardSchemaV1 } from "@cordierite/shared";
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
      "l"
    );

    expect(normalized).toEqual({
      kind: "paired",
      schema: zod3Schema,
      jsonSchema: converter,
    });
  });

  test("a plain object with no ~standard is detected as kind 'raw'", () => {
    expect(normalizeToolSchema(rawJsonSchema, "l")).toEqual({
      kind: "raw",
      jsonSchema: rawJsonSchema,
    });
  });

  test("a JSON Schema whose own keywords include `schema` is still raw", () => {
    const schemaKeyword = { type: "object", schema: { type: "string" } };

    expect(normalizeToolSchema(schemaKeyword, "l")).toEqual({
      kind: "raw",
      jsonSchema: schemaKeyword,
    });
  });

  test("throws when ~standard is present but not a Standard Schema", () => {
    expect(() => normalizeToolSchema({ "~standard": {} }, "MySchema")).toThrow(
      /must expose "~standard.validate"/
    );
  });

  test("throws for a pair missing its jsonSchema half", () => {
    expect(() => normalizeToolSchema({ schema: zod3Schema }, "MySchema")).toThrow(
      /"jsonSchema" is missing or not an object/
    );
  });

  test("throws for non-objects and arrays", () => {
    expect(() => normalizeToolSchema("nope", "MySchema")).toThrow(TypeError);
    expect(() => normalizeToolSchema(null, "MySchema")).toThrow(TypeError);
    expect(() => normalizeToolSchema([{ type: "object" }], "MySchema")).toThrow(
      TypeError
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

  test("returns undefined when the exporter itself throws", () => {
    const throwing = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => success(value),
        jsonSchema: {
          input: () => {
            throw new Error("nope");
          },
          output: () => ({ type: "object" }),
        },
      },
    };

    expect(
      exportToolSchema(normalizeToolSchema(throwing, "l"), "input", "t")
    ).toBeUndefined();
  });
});

describe("exportToolSchema: Standard Schema without an exporter", () => {
  test("throws in dev, naming the tool and pointing at the two supported forms", () => {
    const normalized = normalizeToolSchema(zod3Schema, "l");

    expect(() =>
      withDev(true, () => exportToolSchema(normalized, "input", "zod3-tool"))
    ).toThrow(/zod3-tool/);
    expect(() =>
      withDev(true, () => exportToolSchema(normalized, "input", "zod3-tool"))
    ).toThrow(/schema, jsonSchema/);
  });

  test("throws in dev even when no tool name is available", () => {
    expect(() =>
      withDev(true, () =>
        exportToolSchema(normalizeToolSchema(shapelessSchema, "l"), "input")
      )
    ).toThrow(TypeError);
  });

  test("outside dev it warns once per tool name and registers shapeless", () => {
    const warnings = withWarningsCaptured(() => {
      withDev(false, () => {
        const normalized = normalizeToolSchema(shapelessSchema, "l");

        expect(exportToolSchema(normalized, "input", "prod-tool")).toBeUndefined();
        expect(
          exportToolSchema(normalized, "output", "prod-tool")
        ).toBeUndefined();
      });
    });

    const matching = warnings.filter((args) =>
      args.some((arg) => arg.includes("prod-tool") && arg.includes("shapeless"))
    );
    expect(matching).toHaveLength(1);
  });

  test("does not warn or throw when no schema is provided at all", () => {
    const warnings = withWarningsCaptured(() => {
      expect(exportToolSchema(undefined, "input", "no-schema-tool")).toBeUndefined();
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
      "l"
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
      "l"
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

  test("a paired schema never warns or throws in dev", () => {
    const warnings = withWarningsCaptured(() => {
      withDev(true, () => {
        expect(
          exportToolSchema(
            normalizeToolSchema(
              { schema: zod3Schema, jsonSchema: rawJsonSchema },
              "l"
            ),
            "input",
            "paired-tool"
          )
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
          rawJsonSchema
        );
        expect(exportToolSchema(normalized, "output", "raw-tool")).toEqual(
          rawJsonSchema
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
      "l"
    );

    const failure = await validateToolSchema(normalized, { a: "no" });
    expect(failure.ok).toBe(false);
  });

  test("a raw JSON Schema passes every value through unvalidated", async () => {
    const normalized = normalizeToolSchema(rawJsonSchema, "l");

    // Deliberately does not match `rawJsonSchema`: there is no app-side JSON Schema validator.
    await expect(
      validateToolSchema(normalized, { totally: "unrelated" })
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
      })
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
        "l"
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
          })
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
