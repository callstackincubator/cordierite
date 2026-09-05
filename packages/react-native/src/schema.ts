import {
  isObjectRootedSchema,
  type StandardSchemaV1,
  type StandardSchemaV1JsonSchema,
  type ToolDescriptor,
  type ToolSchemaDescriptor,
} from "@cordierite/shared";

import type {
  CordieriteJsonSchemaConverter,
  CordieriteNormalizedToolSchema,
  CordieriteRuntimeSchema,
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

  // Keyed by slot as well as tool: a tool whose input and output schemas both fail has two
  // distinct problems to fix, and reporting only the first would hide the second.
  const warningKey = `${toolName ?? "<unnamed>"}:${mode}`;
  if (!shapelessToolWarningsSeen.has(warningKey)) {
    shapelessToolWarningsSeen.add(warningKey);
    logger.warn(
      `${label} cannot publish a JSON Schema: ${reason}. It is registered without a schema, so ` +
        `agents will see it as shapeless. ${SHAPE_REMEDY}`,
    );
  }

  return undefined;
};

/** Dedupes the two dev warnings below across repeated registrations of the same tool name. */
const nonObjectOutputWarningsSeen = new Set<string>();
const nonObjectInputWarningsSeen = new Set<string>();

/**
 * Issue #26: MCP's `Tool` wire shape requires both `inputSchema.type` and `outputSchema.type` to be
 * the literal `"object"`, so a schema exported as anything else (`z.array`, `z.string`, a
 * `z.union`'s `anyOf`, a `z.discriminatedUnion`'s `oneOf` or a `z.intersection`'s `allOf` — the
 * last two even when every branch is an object) cannot be put on the wire as-is. The tool is still
 * registered and still callable, and the descriptor still carries the real schema for the CLI and
 * the JS client; only the MCP surface degrades. Warn at registration time so an app author learns
 * it here rather than from an agent.
 *
 * This is a best-effort dev-time hint, not the authority. The MCP server makes the real decision
 * by parsing the composed tool with the SDK's own `ToolSchema` (`mcp/tool-mapping.ts`), which
 * rejects a little more than the root-type check available here — this package cannot depend on
 * the MCP SDK. Every shape zod itself can export is covered by the check below.
 */
const warnNonObjectRootedSchema = (
  toolName: string,
  mode: "input" | "output",
  schema: ToolSchemaDescriptor,
): void => {
  const seen =
    mode === "output"
      ? nonObjectOutputWarningsSeen
      : nonObjectInputWarningsSeen;

  if (seen.has(toolName)) {
    return;
  }
  seen.add(toolName);

  const consequence =
    mode === "output"
      ? "MCP drops it from tools/list, so agents get the result with no schema describing it."
      : "MCP replaces it with a permissive empty object schema, so agents cannot see the tool's " +
        "real arguments.";

  logger.devWarn(
    `Tool "${toolName}" exports a JSON Schema for its ${mode} that is not rooted at ` +
      `type "object" (got ${JSON.stringify(schema.type ?? null)}). ${consequence} ` +
      `Wrap the ${mode} in an object schema (for example z.object({ result: ... })) to keep the ` +
      "full shape over MCP.",
  );
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

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

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

/** The seven type names draft 2020-12 defines. `type` may also be an array of them. */
const JSON_SCHEMA_TYPE_NAMES = [
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "string",
  "integer",
];

const isValidJsonSchemaType = (type: unknown): boolean =>
  Array.isArray(type)
    ? type.length > 0 &&
      type.every(
        (entry) =>
          typeof entry === "string" && JSON_SCHEMA_TYPE_NAMES.includes(entry),
      )
    : typeof type === "string" && JSON_SCHEMA_TYPE_NAMES.includes(type);

/**
 * Whether `value` can be published verbatim as JSON Schema.
 *
 * Structural, not keyword-based, and deliberately so. A keyword probe using `in` walks the
 * prototype chain, and validator instances from libraries that predate Standard Schema (yup, joi,
 * superstruct, valibot 0.x) carry a prototype `type` — they would be classified as raw JSON Schema
 * and published as the tool's shape, where before they were rejected outright. Many also hold
 * circular references, so `JSON.stringify` on the registry snapshot would throw and take the whole
 * snapshot down with it, not just that one tool.
 *
 * So: a plain object (`{}` or `Object.create(null)` — no class, no prototype methods) whose own
 * `type`, if it has one, is a real JSON Schema type name. `{}` is valid JSON Schema (it accepts
 * anything), and is accepted.
 */
const isPlainJsonSchemaObject = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return !hasOwn(value, "type") || isValidJsonSchemaType(value.type);
};

const NOT_JSON_SCHEMA_ADVICE =
  'Pass a plain JSON Schema object such as `{ "type": "object", "properties": { … } }`, a ' +
  "Standard Schema, or a { schema, jsonSchema } pair. A validator instance from a library without " +
  "Standard Schema support (yup, joi, superstruct) is none of those.";

/**
 * Classifies a user-supplied `inputSchema`/`outputSchema` into the three accepted forms
 * (ARCHITECTURE.md §11) exactly once, at registration time:
 *
 * - `standard` — anything (object *or* callable, e.g. arktype) exposing `~standard.validate`;
 * - `paired` — `{ schema, jsonSchema }`, where `schema` is a Standard Schema and `jsonSchema` is a
 *   JSON Schema object or an `{ input, output }` converter;
 * - `raw` — a plain JSON Schema object (see `isPlainJsonSchemaObject`), passed through unvalidated.
 *
 * Everything else throws a `TypeError` rather than being published as the tool's shape: non-objects
 * and arrays, a `~standard` that is not a Standard Schema, a malformed `{ schema, jsonSchema }`
 * pair, and any class instance or object whose `type` is not a JSON Schema type.
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

  // Own properties only, for the same prototype-chain reason `isPlainJsonSchemaObject` explains.
  const looksLikePair = hasOwn(value, "schema") || hasOwn(value, "jsonSchema");
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
    if (isJsonSchemaConverter(jsonSchema)) {
      return { kind: "paired", schema: pairedSchema, jsonSchema };
    }

    if (!isPlainJsonSchemaObject(jsonSchema)) {
      throw new TypeError(
        `${label} looks like a { schema, jsonSchema } pair but its "jsonSchema" half is not a plain ` +
          `JSON Schema object or an { input, output } converter. ${NOT_JSON_SCHEMA_ADVICE}`,
      );
    }

    return {
      kind: "paired",
      schema: pairedSchema,
      jsonSchema: jsonSchema as Record<string, unknown>,
    };
  }

  if (!isPlainJsonSchemaObject(value)) {
    throw new TypeError(
      `${label} is not a Standard Schema and is not a plain JSON Schema object. ${NOT_JSON_SCHEMA_ADVICE}`,
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

const describe = (value: unknown): string => {
  if (Array.isArray(value)) {
    return "an array";
  }
  if (value === null) {
    return "null";
  }
  if (isRecord(value)) {
    return "an object that is not plain JSON Schema";
  }
  return typeof value;
};

/**
 * Runs one half of a JSON Schema converter. A converter that throws, or hands back anything that is
 * not a plain JSON Schema object, is a failure to be *reported*, never swallowed: silently
 * returning `undefined` here would put back exactly the shapeless-tool failure this contract exists
 * to remove — and for pair users, who chose the pair form precisely to avoid it. The result is held
 * to the same standard as a hand-written raw schema, so the two forms cannot diverge.
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

  return isPlainJsonSchemaObject(exported)
    ? { ok: true, schema: exported as ToolSchemaDescriptor }
    : {
        ok: false,
        reason: `its ${source} returned ${describe(
          exported,
        )} instead of a JSON Schema object`,
      };
};

/** Export outcome for one normalized slot, with the reason when no JSON Schema can be produced. */
const exportNormalizedSchema = (
  schema: CordieriteNormalizedToolSchema,
  mode: "input" | "output",
): ConverterOutcome => {
  if (schema.kind === "raw") {
    return { ok: true, schema: schema.jsonSchema };
  }

  if (schema.kind === "paired") {
    if (!isJsonSchemaConverter(schema.jsonSchema)) {
      return { ok: true, schema: schema.jsonSchema };
    }

    return exportFromConverter(
      schema.jsonSchema,
      mode,
      `"jsonSchema.${mode}" converter`,
    );
  }

  if (!hasJsonSchemaExporter(schema.schema)) {
    return { ok: false, reason: missingExporterReason };
  }

  return exportFromConverter(
    schema.schema["~standard"].jsonSchema as CordieriteJsonSchemaConverter,
    mode,
    `"~standard.jsonSchema.${mode}" exporter`,
  );
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

  const outcome = exportNormalizedSchema(schema, mode);
  return outcome.ok
    ? outcome.schema
    : reportShapelessSchema(outcome.reason, mode, toolName);
};

/**
 * Render-time exporter for `useCordieriteTool`'s derived registration key. Takes the raw
 * `inputSchema`/`outputSchema` value as the caller passed it, and never throws or warns: an
 * invalid value or a shapeless schema yields `undefined` here, and the registration path
 * (`toToolDescriptor` via `registerTool`) is where it is reported. Keying is not the place to
 * fail a render or to log.
 */
export const exportToolSchemaForKey = (
  schema: CordieriteRuntimeSchema,
  mode: "input" | "output",
): ToolSchemaDescriptor | undefined => {
  let normalized: CordieriteNormalizedToolSchema;
  try {
    normalized = normalizeToolSchema(schema, "schema");
  } catch {
    return undefined;
  }

  const outcome = exportNormalizedSchema(normalized, mode);
  return outcome.ok ? outcome.schema : undefined;
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

  if (inputSchema !== undefined && !isObjectRootedSchema(inputSchema)) {
    warnNonObjectRootedSchema(definition.name, "input", inputSchema);
  }

  if (outputSchema !== undefined && !isObjectRootedSchema(outputSchema)) {
    warnNonObjectRootedSchema(definition.name, "output", outputSchema);
  }

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
