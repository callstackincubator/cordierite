import type {
  StandardSchemaV1,
  StandardSchemaV1JsonSchema,
  ToolDescriptor,
  ToolSchemaDescriptor,
} from "@cordierite/shared";

import type {
  CordieriteRuntimeSchema,
  CordieriteToolDefinition,
} from "./Cordierite.types";
import { logger } from "./logger";

const JSON_SCHEMA_TARGET = "draft-2020-12";

/** Dedupes the dev warning below across repeated registrations of the same tool name. */
const shapelessToolWarningsSeen = new Set<string>();

/**
 * ARCHITECTURE.md §11: when a provided Standard Schema does not export JSON Schema (zod 3, valibot
 * without an adapter), the tool is still registered — just with an empty `input_schema`/
 * `output_schema` — so warn once per tool name that agents will see it as shapeless.
 */
const warnMissingSchemaExporter = (toolName: string): void => {
  if (shapelessToolWarningsSeen.has(toolName)) {
    return;
  }
  shapelessToolWarningsSeen.add(toolName);
  logger.devWarn(
    `Tool "${toolName}" has a Standard Schema that does not export JSON Schema ` +
      `("~standard.jsonSchema" is missing — this is expected for zod 3 and plain valibot). It will ` +
      "be registered without a schema, so agents will see it as shapeless. Use zod v4 (built-in " +
      'exporter) or a wrapper that implements "~standard.jsonSchema" to give agents a real shape.'
  );
};

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

export const requireOptionalStandardSchema = (
  value: unknown,
  label: string
): StandardSchemaV1 | undefined =>
  value === undefined ? undefined : requireStandardSchema(value, label);

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

/** `undefined` when there is no schema, or it does not export JSON Schema (§7: `input_schema?`/`output_schema?` are optional). */
export const exportToolSchema = (
  schema: StandardSchemaV1 | undefined,
  mode: "input" | "output",
  toolName?: string
): ToolSchemaDescriptor | undefined => {
  if (!schema) {
    return undefined;
  }

  if (!hasJsonSchemaExporter(schema)) {
    if (toolName !== undefined) {
      warnMissingSchemaExporter(toolName);
    }
    return undefined;
  }

  try {
    const exported = schema["~standard"].jsonSchema[mode]({
      target: JSON_SCHEMA_TARGET,
    });
    return isRecord(exported) ? exported : undefined;
  } catch {
    return undefined;
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
  definition: CordieriteToolDefinition<
    CordieriteRuntimeSchema | undefined,
    CordieriteRuntimeSchema | undefined
  >
): ToolDescriptor => {
  const inputSchema = exportToolSchema(
    definition.inputSchema,
    "input",
    definition.name
  );
  const outputSchema = exportToolSchema(
    definition.outputSchema,
    "output",
    definition.name
  );

  return {
    name: definition.name,
    description: definition.description,
    ...(inputSchema !== undefined ? { input_schema: inputSchema } : {}),
    ...(outputSchema !== undefined ? { output_schema: outputSchema } : {}),
    ...(definition.annotations !== undefined
      ? { annotations: definition.annotations }
      : {}),
  };
};
