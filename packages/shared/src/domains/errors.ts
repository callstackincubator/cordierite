/**
 * The canonical error-type union (ARCHITECTURE.md §5). This is the single source of truth
 * shared by the daemon, CLI, MCP, and React Native packages: JSON-RPC `error.data.type` and the
 * app-side `tool_error.error.type` values must both be members of this union, and both must be
 * preserved verbatim end-to-end — never re-wrapped under a generic type.
 */
export const ERROR_TYPES = [
  "no_session",
  "ambiguous_session",
  "unknown_session",
  "session_not_active",
  "tool_not_found",
  "tool_input_validation_error",
  "tool_output_validation_error",
  "tool_execution_error",
  "tool_serialization_error",
  "tool_timeout",
  "session_suspended",
  "policy_denied",
  "invalid_request",
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

const ERROR_TYPE_SET: ReadonlySet<string> = new Set(ERROR_TYPES);

export const isKnownErrorType = (value: unknown): value is ErrorType => {
  return typeof value === "string" && ERROR_TYPE_SET.has(value);
};

/** The subset of {@link ErrorType} carried on the app-side `tool_error` wire message (§7). */
export const TOOL_ERROR_TYPES = [
  "tool_not_found",
  "tool_input_validation_error",
  "tool_output_validation_error",
  "tool_execution_error",
  "tool_serialization_error",
  "tool_timeout",
] as const satisfies readonly ErrorType[];

export type ToolErrorType = (typeof TOOL_ERROR_TYPES)[number];

const TOOL_ERROR_TYPE_SET: ReadonlySet<string> = new Set(TOOL_ERROR_TYPES);

export const isToolErrorType = (value: unknown): value is ToolErrorType => {
  return typeof value === "string" && TOOL_ERROR_TYPE_SET.has(value);
};
