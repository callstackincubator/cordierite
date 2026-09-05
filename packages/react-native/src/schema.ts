import type {
  StandardSchemaV1,
  StandardSchemaV1JsonSchema,
  ToolDescriptor,
  ToolSchemaDescriptor,
} from "@cordierite/shared";

import type {
  CordieriteJsonSchemaConverter,
  CordieriteNormalizedToolSchema,
  CordieriteToolDefinition,
} from "./Cordierite.types";
import { logger } from "./logger";

declare const __DEV__: boolean | undefined;

const isDev = (): boolean => typeof __DEV__ !== "undefined" && Boolean(__DEV__);

const JSON_SCHEMA_TARGET = "draft-2020-12";

/** Dedupes the production warning below across repeated registrations of the same tool name. */
const shapelessToolWarningsSeen = new Set<string>();

/**
 * Points at the two supported ways to give a schema a shape when its library has no
 * `~standard.jsonSchema` exporter. Shared by the dev throw and the production warning so the two
 * never drift apart.
 */
const MISSING_EXPORTER_REMEDY =
  'Pass `{ schema, jsonSchema }` (e.g. `{ schema, jsonSchema: zodToJsonSchema(schema, { target: "jsonSchema2020-12" }) }` ' +
  "for zod 3, `toJsonSchema(schema)` from `@valibot/to-json-schema` for valibot), pass a raw JSON " +
  "Schema object instead of the schema, or use a library with a built-in exporter (zod 4, arktype).";

const missingExporterMessage = (label: string): string =>
  `${label} is a Standard Schema without a JSON Schema exporter ` +
  '("~standard.jsonSchema" is missing — expected for zod 3 and plain valibot), so agents would see ' +
  `the tool as shapeless. ${MISSING_EXPORTER_REMEDY}`;

/**
 * ARCHITECTURE.md §11: outside dev, a Standard Schema with no JSON Schema exporter still registers
 * — just with no `input_schema`/`output_schema` — so an app that shipped one keeps working. Warn
 * once per tool name that agents will see it as shapeless. In dev this case throws instead (see
 * `exportToolSchema`).
 */
const warnMissingSchemaExporter = (toolName: string): void => {
  if (shapelessToolWarningsSeen.has(toolName)) {
    return;
  }
  shapelessToolWarningsSeen.add(toolName);
  logger.warn(
    `Tool "${toolName}" has a Standard Schema that does not export JSON Schema ` +
      `("~standard.jsonSchema" is missing — this is expected for zod 3 and plain valibot). It will ` +
      `be registered without a schema, so agents will see it as shapeless. ${MISSING_EXPORTER_REMEDY}`
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asStandardSchema = (value: unknown): StandardSchemaV1 | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const standard = value["~standard"];
  if (!isRecord(standard) || typeof standard.validate !== "function") {
    return undefined;
  }

  return value as unknown as StandardSchemaV1;
};

const isJsonSchemaConverter = (
  value: unknown
): value is CordieriteJsonSchemaConverter =>
  isRecord(value) &&
  typeof value.input === "function" &&
  typeof value.output === "function";

/**
 * Classifies a user-supplied `inputSchema`/`outputSchema` into the three accepted forms
 * (ARCHITECTURE.md §11) exactly once, at registration time:
 *
 * - `standard` — anything exposing `~standard.validate` (zod 3/4, valibot, arktype);
 * - `paired` — `{ schema, jsonSchema }`, where `schema` is a Standard Schema and `jsonSchema` is a
 *   JSON Schema object or an `{ input, output }` converter;
 * - `raw` — any other plain object, taken as a JSON Schema and passed through unvalidated.
 *
 * Throws a `TypeError` for values that are neither (non-objects, arrays) and for the two shapes
 * that are almost certainly a mistake: a `~standard` that is not a Standard Schema, and a
 * `{ schema }` pair missing its `jsonSchema` half.
 */
export const normalizeToolSchema = (
  value: unknown,
  label: string
): CordieriteNormalizedToolSchema => {
  if (!isRecord(value)) {
    throw new TypeError(
      `${label} must be a Standard Schema object, a { schema, jsonSchema } pair, or a JSON Schema object.`
    );
  }

  if ("~standard" in value) {
    const schema = asStandardSchema(value);
    if (!schema) {
      throw new TypeError(`${label} must expose "~standard.validate".`);
    }
    return { kind: "standard", schema };
  }

  // Only a `schema` that really is a Standard Schema makes this a pair; a JSON Schema that merely
  // happens to have a `schema` keyword still falls through to `raw` below.
  const pairedSchema = asStandardSchema(value.schema);
  if (pairedSchema) {
    const { jsonSchema } = value;
    if (!isRecord(jsonSchema)) {
      throw new TypeError(
        `${label} looks like a { schema, jsonSchema } pair but its "jsonSchema" is missing or not an object. ` +
          "Supply a JSON Schema object or an { input, output } converter."
      );
    }
    return {
      kind: "paired",
      schema: pairedSchema,
      jsonSchema: isJsonSchemaConverter(jsonSchema)
        ? jsonSchema
        : (jsonSchema as Record<string, unknown>),
    };
  }

  return { kind: "raw", jsonSchema: value };
};

export const normalizeOptionalToolSchema = (
  value: unknown,
  label: string
): CordieriteNormalizedToolSchema | undefined =>
  value === undefined ? undefined : normalizeToolSchema(value, label);

const hasJsonSchemaExporter = (
  schema: StandardSchemaV1
): schema is StandardSchemaV1JsonSchema => {
  const standard = schema["~standard"] as unknown as Record<string, unknown>;

  return isJsonSchemaConverter(standard.jsonSchema);
};

const exportFromConverter = (
  converter: CordieriteJsonSchemaConverter,
  mode: "input" | "output"
): ToolSchemaDescriptor | undefined => {
  try {
    const exported = converter[mode]({ target: JSON_SCHEMA_TARGET });
    return isRecord(exported) ? exported : undefined;
  } catch {
    return undefined;
  }
};

/**
 * JSON Schema to publish for one slot, or `undefined` when there is none (§7: `input_schema`/
 * `output_schema` are optional).
 *
 * A `standard` schema with no exporter **throws in dev** (`__DEV__`) so the "registered fine but
 * the agent can't use it" failure is loud where it can still be fixed; in production it warns once
 * and registers shapeless, exactly as before, so an app already shipping such a tool is not bricked
 * by an upgrade.
 */
export const exportToolSchema = (
  schema: CordieriteNormalizedToolSchema | undefined,
  mode: "input" | "output",
  toolName?: string
): ToolSchemaDescriptor | undefined => {
  if (!schema) {
    return undefined;
  }

  if (schema.kind === "raw") {
    return schema.jsonSchema;
  }

  if (schema.kind === "paired") {
    return isJsonSchemaConverter(schema.jsonSchema)
      ? exportFromConverter(schema.jsonSchema, mode)
      : schema.jsonSchema;
  }

  if (!hasJsonSchemaExporter(schema.schema)) {
    const label =
      toolName !== undefined
        ? `Tool "${toolName}" ${mode}Schema`
        : `The tool ${mode}Schema`;

    if (isDev()) {
      throw new TypeError(missingExporterMessage(label));
    }

    if (toolName !== undefined) {
      warnMissingSchemaExporter(toolName);
    }
    return undefined;
  }

  return exportFromConverter(
    schema.schema["~standard"].jsonSchema as CordieriteJsonSchemaConverter,
    mode
  );
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

export type CordieriteToolSchemaValidationResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      issues: NormalizedStandardSchemaIssue[];
    };

/**
 * Runs the slot's runtime validation. `standard` and `paired` both validate through
 * `~standard.validate`; a `raw` JSON Schema has no validator at all, so the value passes through
 * untouched — deliberately, since bundling a JSON Schema validator would break this package's
 * zero-runtime-dependency guarantee (ARCHITECTURE.md §13).
 */
export const validateToolSchema = async (
  schema: CordieriteNormalizedToolSchema,
  value: unknown
): Promise<CordieriteToolSchemaValidationResult> => {
  if (schema.kind === "raw") {
    return { ok: true, value };
  }

  const result = await schema.schema["~standard"].validate(value);

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

/** A tool definition whose schemas have already been through `normalizeToolSchema`. */
export type CordieriteNormalizedToolDefinition = Pick<
  CordieriteToolDefinition,
  "name" | "description" | "annotations"
> & {
  inputSchema?: CordieriteNormalizedToolSchema;
  outputSchema?: CordieriteNormalizedToolSchema;
};

export const toToolDescriptor = (
  definition: CordieriteNormalizedToolDefinition
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
