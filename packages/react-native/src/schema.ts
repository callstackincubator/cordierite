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
import { isDev, logger } from "./logger";

const JSON_SCHEMA_TARGET = "draft-2020-12";

/** Dedupes the production warning below across repeated registrations of the same tool name. */
const shapelessToolWarningsSeen = new Set<string>();

/**
 * Points at the supported ways to give a schema a shape. Shared by every dev throw and production
 * warning below so the advice can never drift between them.
 */
const SHAPE_REMEDY =
  "Pass `{ schema, jsonSchema }` (e.g. `{ schema, jsonSchema: zodToJsonSchema(schema) }` for zod 3, " +
  "`{ schema, jsonSchema: toJsonSchema(schema) }` with `@valibot/to-json-schema` for valibot), pass " +
  "a raw JSON Schema object instead of the schema, or use a library with a built-in " +
  '"~standard.jsonSchema" exporter (zod 4, arktype).';

const missingExporterReason =
  'it is a Standard Schema without a JSON Schema exporter ("~standard.jsonSchema" is missing — ' +
  "expected for zod 3 and plain valibot)";

/**
 * The one place a tool ends up shapeless. ARCHITECTURE.md §11: in dev this throws, so the
 * "registered fine but the agent cannot use it" failure is loud while it can still be fixed;
 * outside dev the tool still registers with no `input_schema`/`output_schema` — warning once per
 * tool name — so an app that already shipped one is not bricked by an upgrade.
 */
const reportShapelessSchema = (
  reason: string,
  mode: "input" | "output",
  toolName: string | undefined,
): undefined => {
  const label =
    toolName !== undefined
      ? `Tool "${toolName}" ${mode}Schema`
      : `The tool ${mode}Schema`;

  if (isDev()) {
    throw new TypeError(
      `${label} cannot publish a JSON Schema: ${reason}. Agents would see the tool as shapeless. ${SHAPE_REMEDY}`,
    );
  }

  const warningKey = toolName ?? "<unnamed>";
  if (!shapelessToolWarningsSeen.has(warningKey)) {
    shapelessToolWarningsSeen.add(warningKey);
    logger.warn(
      `${label} cannot publish a JSON Schema: ${reason}. It is registered without a schema, so ` +
        `agents will see it as shapeless. ${SHAPE_REMEDY}`,
    );
  }

  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A Standard Schema need not be a plain object: arktype's `Type` is *callable*, so `typeof` reports
 * `"function"` while `~standard` sits on it as a property. Anything indexable that carries a real
 * `~standard.validate` counts.
 */
const isIndexable = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" || typeof value === "function") && value !== null;

const hasStandardProperty = (value: unknown): boolean =>
  isIndexable(value) && "~standard" in value;

const asStandardSchema = (value: unknown): StandardSchemaV1 | undefined => {
  if (!isIndexable(value)) {
    return undefined;
  }

  const standard = value["~standard"];
  if (!isRecord(standard) || typeof standard.validate !== "function") {
    return undefined;
  }

  return value as unknown as StandardSchemaV1;
};

const isJsonSchemaConverter = (
  value: unknown,
): value is CordieriteJsonSchemaConverter =>
  isRecord(value) &&
  typeof value.input === "function" &&
  typeof value.output === "function";

/**
 * Keywords that make an object recognisable as JSON Schema. A raw schema must carry at least one:
 * without it, "raw" is a catch-all that would happily publish a mistyped pair or an unrelated
 * object as the tool's shape.
 */
const JSON_SCHEMA_KEYWORDS = [
  "type",
  "properties",
  "$ref",
  "anyOf",
  "allOf",
  "oneOf",
  "enum",
  "const",
] as const;

/**
 * Classifies a user-supplied `inputSchema`/`outputSchema` into the three accepted forms
 * (ARCHITECTURE.md §11) exactly once, at registration time:
 *
 * - `standard` — anything (object *or* callable, e.g. arktype) exposing `~standard.validate`;
 * - `paired` — `{ schema, jsonSchema }`, where `schema` is a Standard Schema and `jsonSchema` is a
 *   JSON Schema object or an `{ input, output }` converter;
 * - `raw` — a plain object carrying at least one JSON Schema keyword, passed through unvalidated.
 *
 * Everything else throws a `TypeError`, rather than being published as the tool's shape: non-objects
 * and arrays, a `~standard` that is not a Standard Schema, a `{ schema }` pair missing or
 * mistyping its `jsonSchema` half, and any object that mentions `schema`/`jsonSchema` without
 * being a valid pair (overwhelmingly a malformed pair, not JSON Schema — neither is a JSON Schema
 * keyword).
 */
export const normalizeToolSchema = (
  value: unknown,
  label: string,
): CordieriteNormalizedToolSchema => {
  if (hasStandardProperty(value)) {
    const schema = asStandardSchema(value);
    if (!schema) {
      throw new TypeError(`${label} must expose "~standard.validate".`);
    }
    return { kind: "standard", schema };
  }

  if (!isRecord(value)) {
    throw new TypeError(
      `${label} must be a Standard Schema, a { schema, jsonSchema } pair, or a JSON Schema object.`,
    );
  }

  const looksLikePair = "schema" in value || "jsonSchema" in value;
  if (looksLikePair) {
    const pairedSchema = asStandardSchema(value.schema);
    if (!pairedSchema) {
      throw new TypeError(
        `${label} looks like a { schema, jsonSchema } pair but its "schema" is missing or is not a ` +
          'Standard Schema (no "~standard.validate"). Supply the validation schema there, and the ' +
          'JSON Schema to publish under "jsonSchema".',
      );
    }

    const { jsonSchema } = value;
    if (!isRecord(jsonSchema)) {
      throw new TypeError(
        `${label} looks like a { schema, jsonSchema } pair but its "jsonSchema" is missing or not an object. ` +
          "Supply a JSON Schema object or an { input, output } converter.",
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

  const keyword = JSON_SCHEMA_KEYWORDS.find((candidate) => candidate in value);
  if (keyword === undefined) {
    throw new TypeError(
      `${label} is not a Standard Schema and does not look like JSON Schema: it has none of ` +
        `${JSON_SCHEMA_KEYWORDS.join(", ")}. ${SHAPE_REMEDY}`,
    );
  }

  return { kind: "raw", jsonSchema: value };
};

export const normalizeOptionalToolSchema = (
  value: unknown,
  label: string,
): CordieriteNormalizedToolSchema | undefined =>
  value === undefined ? undefined : normalizeToolSchema(value, label);

const hasJsonSchemaExporter = (
  schema: StandardSchemaV1,
): schema is StandardSchemaV1JsonSchema => {
  const standard = schema["~standard"] as unknown as Record<string, unknown>;

  return isJsonSchemaConverter(standard.jsonSchema);
};

type ConverterOutcome =
  { ok: true; schema: ToolSchemaDescriptor } | { ok: false; reason: string };

/**
 * Runs one half of a JSON Schema converter. A converter that throws or returns a non-object is a
 * failure to be *reported*, never swallowed: silently returning `undefined` here would put back
 * exactly the shapeless-tool failure this contract exists to remove — and for pair users, who
 * chose the pair form precisely to avoid it.
 */
const exportFromConverter = (
  converter: CordieriteJsonSchemaConverter,
  mode: "input" | "output",
  source: string,
): ConverterOutcome => {
  let exported: unknown;
  try {
    exported = converter[mode]({ target: JSON_SCHEMA_TARGET });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `its ${source} threw (${detail})` };
  }

  return isRecord(exported)
    ? { ok: true, schema: exported }
    : {
        ok: false,
        reason: `its ${source} returned ${
          Array.isArray(exported) ? "an array" : typeof exported
        } instead of a JSON Schema object`,
      };
};

/**
 * JSON Schema to publish for one slot, or `undefined` when there is none (§7: `input_schema`/
 * `output_schema` are optional).
 *
 * Every way a slot can fail to produce a shape — a Standard Schema with no exporter, an exporter
 * that throws, a paired converter that throws — goes through `reportShapelessSchema`, which throws
 * in `__DEV__` and warns once per tool name otherwise.
 */
export const exportToolSchema = (
  schema: CordieriteNormalizedToolSchema | undefined,
  mode: "input" | "output",
  toolName?: string,
): ToolSchemaDescriptor | undefined => {
  if (!schema) {
    return undefined;
  }

  if (schema.kind === "raw") {
    return schema.jsonSchema;
  }

  if (schema.kind === "paired") {
    if (!isJsonSchemaConverter(schema.jsonSchema)) {
      return schema.jsonSchema;
    }

    const outcome = exportFromConverter(
      schema.jsonSchema,
      mode,
      `"jsonSchema.${mode}" converter`,
    );
    return outcome.ok
      ? outcome.schema
      : reportShapelessSchema(outcome.reason, mode, toolName);
  }

  if (!hasJsonSchemaExporter(schema.schema)) {
    return reportShapelessSchema(missingExporterReason, mode, toolName);
  }

  const outcome = exportFromConverter(
    schema.schema["~standard"].jsonSchema as CordieriteJsonSchemaConverter,
    mode,
    `"~standard.jsonSchema.${mode}" exporter`,
  );
  return outcome.ok
    ? outcome.schema
    : reportShapelessSchema(outcome.reason, mode, toolName);
};

export type NormalizedStandardSchemaIssue = {
  message: string;
  path?: PropertyKey[];
};

const normalizePathSegment = (
  segment: PropertyKey | StandardSchemaV1.PathSegment,
): PropertyKey =>
  typeof segment === "object" && segment !== null && "key" in segment
    ? segment.key
    : segment;

export const normalizeStandardSchemaIssues = (
  issues: readonly StandardSchemaV1.Issue[],
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
  value: unknown,
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
  definition: CordieriteNormalizedToolDefinition,
): ToolDescriptor => {
  const inputSchema = exportToolSchema(
    definition.inputSchema,
    "input",
    definition.name,
  );
  const outputSchema = exportToolSchema(
    definition.outputSchema,
    "output",
    definition.name,
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
