/** Draft 2020-12 JSON Schema object; internals are never validated, only that it is a JSON object. */
export type ToolSchemaDescriptor = Record<string, unknown>;

/** `[a-zA-Z0-9_-]{1,64}` (ARCHITECTURE.md §7). */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export const MAX_TOOL_DESCRIPTION_LENGTH = 4096;

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
};

const TOOL_ANNOTATION_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint"] as const;

export type ToolDescriptor = {
  /** Required, unique per session, `[a-zA-Z0-9_-]{1,64}`. */
  name: string;
  description: string;
  input_schema?: ToolSchemaDescriptor;
  output_schema?: ToolSchemaDescriptor;
  annotations?: ToolAnnotations;
  /**
   * The app-declared per-call deadline for this tool, in milliseconds (a positive integer). The
   * daemon uses it as the default `tools.call` timeout when the caller passes none; an explicit
   * caller `timeoutMs` still wins. Optional — older apps omit it and keep the daemon's default.
   */
  timeoutMs?: number;
};

const isJsonObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isValidOptionalSchema = (value: unknown): boolean => {
  return value === undefined || isJsonObject(value);
};

const isValidAnnotations = (value: unknown): value is ToolAnnotations | undefined => {
  if (value === undefined) {
    return true;
  }

  if (!isJsonObject(value)) {
    return false;
  }

  for (const key of Object.keys(value)) {
    if (!(TOOL_ANNOTATION_KEYS as readonly string[]).includes(key)) {
      return false;
    }
  }

  return TOOL_ANNOTATION_KEYS.every((key) => value[key] === undefined || typeof value[key] === "boolean");
};

/**
 * Strict `ToolDescriptor` guard. Every element of a `tool_registry_snapshot`/`tool_registry_delta`
 * must pass this before any field access — an invalid element (including `null`) must never be
 * indexed into.
 */
export const isToolDescriptor = (value: unknown): value is ToolDescriptor => {
  if (!isJsonObject(value)) {
    return false;
  }

  if (typeof value.name !== "string" || !TOOL_NAME_PATTERN.test(value.name)) {
    return false;
  }

  if (typeof value.description !== "string" || value.description.length === 0) {
    return false;
  }

  if (value.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
    return false;
  }

  if (!isValidOptionalSchema(value.input_schema)) {
    return false;
  }

  if (!isValidOptionalSchema(value.output_schema)) {
    return false;
  }

  if (!isValidAnnotations(value.annotations)) {
    return false;
  }

  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) <= 0)) {
    return false;
  }

  return true;
};

/**
 * Whether an exported JSON Schema is rooted at the literal `type: "object"`.
 *
 * MCP's `Tool` wire shape (`@modelcontextprotocol/sdk`) declares both `inputSchema.type` and
 * `outputSchema.type` as `z.literal("object")` and clients validate the whole `tools/list` result,
 * so a single schema rooted at anything else (`z.array`, `z.string`, a `z.union`'s `anyOf`, a
 * `z.discriminatedUnion`'s `oneOf` or a `z.intersection`'s `allOf` — the last two even when every
 * branch is an object) makes the client reject the *entire* list.
 *
 * This is the *cheap* gate, for the app-side dev warning in `@cordierite/react-native`, which
 * cannot depend on the MCP SDK: it catches every shape zod can actually export. MCP constrains
 * more than the root type (`properties` must be a record of object subschemas, `required` must be
 * an array), so the MCP server's own decision to emit or drop a schema is made by parsing the
 * composed tool with the SDK's `ToolSchema` — see `mcp/tool-mapping.ts` — never by this predicate.
 */
export const isObjectRootedSchema = (schema: ToolSchemaDescriptor | undefined): boolean => {
  return schema !== undefined && schema.type === "object";
};
