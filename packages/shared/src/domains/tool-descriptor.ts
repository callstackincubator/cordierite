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

/**
 * The bounds the daemon enforces on any `tools.call` deadline (`docs/ARCHITECTURE.md` §5), and the
 * deadline it applies when neither the caller nor the tool declares one.
 *
 * These live here, in the shared wire vocabulary, rather than in the daemon: a tool's declared
 * {@link ToolDescriptor.timeout_ms} now crosses the wire, so the app's own abort timer and the
 * daemon's timer must be derived from the same numbers. Two copies would silently drift into a
 * disagreement where one side gives up while the other is still waiting.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
export const MIN_TOOL_TIMEOUT_MS = 1_000;
export const MAX_TOOL_TIMEOUT_MS = 600_000;

/**
 * Normalizes a declared or caller-supplied timeout to a whole number of milliseconds inside
 * [{@link MIN_TOOL_TIMEOUT_MS}, {@link MAX_TOOL_TIMEOUT_MS}]. Callers must reject non-finite input
 * before calling this — `Math.trunc(NaN)` is `NaN`, which no comparison would clamp.
 */
export const clampToolTimeoutMs = (timeoutMs: number): number => {
  return Math.min(Math.max(Math.trunc(timeoutMs), MIN_TOOL_TIMEOUT_MS), MAX_TOOL_TIMEOUT_MS);
};

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
   *
   * snake_case like every other protocol-defined field on this descriptor; the camelCase
   * `timeoutMs` spelling belongs to the RN `registerTool` option and the `tools.call` RPC param,
   * which are camelCase layers. A camelCase key arriving here is not a timeout and is ignored.
   */
  timeout_ms?: number;
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

  if (
    value.timeout_ms !== undefined &&
    (!Number.isInteger(value.timeout_ms) || (value.timeout_ms as number) <= 0)
  ) {
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
