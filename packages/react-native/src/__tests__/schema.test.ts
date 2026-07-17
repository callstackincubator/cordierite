import type { StandardSchemaV1 } from "@cordierite/shared";
import { describe, expect, test } from "vitest";

import { exportToolSchema, toToolDescriptor } from "../schema";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

const success = <T>(value: T): StandardSchemaV1.SuccessResult<T> => ({
  value,
});

/** A Standard Schema without a JSON Schema exporter — the zod 3 / valibot shape. */
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
      output: () => ({ type: "object" }),
    },
  } as unknown as StandardSchemaV1["~standard"],
});

const withDevWarnCaptured = (run: () => void): string[][] => {
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

describe("exportToolSchema: missing JSON Schema exporter", () => {
  test("returns undefined and warns once when a tool name is given", () => {
    const warnings = withDevWarnCaptured(() => {
      const result = exportToolSchema(shapelessSchema, "input", "my-tool");
      expect(result).toBeUndefined();
    });

    expect(
      warnings.some((args) =>
        args.some((arg) => arg.includes("my-tool") && arg.includes("shapeless"))
      )
    ).toBe(true);
  });

  test("does not warn a second time for the same tool name", () => {
    const warnings = withDevWarnCaptured(() => {
      exportToolSchema(shapelessSchema, "input", "dup-tool");
      exportToolSchema(shapelessSchema, "output", "dup-tool");
    });

    const matching = warnings.filter((args) =>
      args.some((arg) => arg.includes("dup-tool"))
    );
    expect(matching).toHaveLength(1);
  });

  test("does not warn when no schema is provided at all", () => {
    const warnings = withDevWarnCaptured(() => {
      const result = exportToolSchema(undefined, "input", "no-schema-tool");
      expect(result).toBeUndefined();
    });

    expect(warnings).toEqual([]);
  });

  test("does not warn when the schema does export JSON Schema", () => {
    const warnings = withDevWarnCaptured(() => {
      const result = exportToolSchema(
        withJsonSchemaExporter(),
        "input",
        "shaped-tool"
      );
      expect(result).toEqual({ type: "object" });
    });

    expect(warnings).toEqual([]);
  });
});

describe("toToolDescriptor: shapeless tool still registers", () => {
  test("registers with no input_schema/output_schema fields, not a throw", () => {
    withDevWarnCaptured(() => {
      const descriptor = toToolDescriptor({
        name: "shapeless-registered",
        description: "d",
        inputSchema: shapelessSchema,
        outputSchema: shapelessSchema,
      });

      expect(descriptor).toEqual({
        name: "shapeless-registered",
        description: "d",
      });
    });
  });
});
