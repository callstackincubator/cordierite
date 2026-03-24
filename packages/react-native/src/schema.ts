import type {
  StandardSchemaV1,
  StandardSchemaV1JsonSchema,
  ToolDescriptor,
  ToolSchemaDescriptor,
} from "@cordierite/shared";

import type { CordieriteToolDefinition } from "./Cordierite.types";

const JSON_SCHEMA_TARGET = "draft-2020-12";
const EMPTY_SCHEMA_DESCRIPTOR: ToolSchemaDescriptor = {};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireStandardSchema = (
  value: unknown,
  label: string
): StandardSchemaV1 => {
  if (!isRecord(value)) {
    throw new TypeError(
      `${label} must be a Standard Schema compatible object.`
    );
  }

  const standard = value["~standard"];
  if (!isRecord(standard) || typeof standard.validate !== "function") {
    throw new TypeError(`${label} must expose "~standard.validate".`);
  }

  return value as unknown as StandardSchemaV1;
};

const hasJsonSchemaExporter = (
  schema: StandardSchemaV1
): schema is StandardSchemaV1JsonSchema => {
  const standard = schema["~standard"] as unknown as Record<string, unknown>;
  const jsonSchema = standard.jsonSchema;

  return (
    isRecord(jsonSchema) &&
    typeof jsonSchema.input === "function" &&
    typeof jsonSchema.output === "function"
  );
};

export const exportToolSchema = (
  schema: StandardSchemaV1,
  mode: "input" | "output"
): ToolSchemaDescriptor => {
  if (!hasJsonSchemaExporter(schema)) {
    return EMPTY_SCHEMA_DESCRIPTOR;
  }

  try {
    const exported = schema["~standard"].jsonSchema[mode]({
      target: JSON_SCHEMA_TARGET,
    });
    return isRecord(exported) ? exported : EMPTY_SCHEMA_DESCRIPTOR;
  } catch {
    return EMPTY_SCHEMA_DESCRIPTOR;
  }
};

export type NormalizedStandardSchemaIssue = {
  message: string;
  path?: PropertyKey[];
};

const normalizePathSegment = (
  segment: PropertyKey | StandardSchemaV1.PathSegment
): PropertyKey =>
  typeof segment === "object" && segment !== null && "key" in segment
    ? segment.key
    : segment;

export const normalizeStandardSchemaIssues = (
  issues: readonly StandardSchemaV1.Issue[]
): NormalizedStandardSchemaIssue[] => {
  return issues.map((issue) => ({
    message: issue.message,
    path: issue.path?.map(normalizePathSegment),
  }));
};

export type StandardSchemaValidationResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      issues: NormalizedStandardSchemaIssue[];
    };

export const validateStandardSchema = async (
  schema: StandardSchemaV1,
  value: unknown
): Promise<StandardSchemaValidationResult> => {
  const result = await schema["~standard"].validate(value);

  if (result.issues) {
    return {
      ok: false,
      issues: normalizeStandardSchemaIssues(result.issues),
    };
  }

  return {
    ok: true,
    value: result.value,
  };
};

export const toToolDescriptor = (
  definition: CordieriteToolDefinition
): ToolDescriptor => ({
  name: definition.name,
  description: definition.description,
  input_schema: exportToolSchema(definition.input_schema, "input"),
  output_schema: exportToolSchema(definition.output_schema, "output"),
});
