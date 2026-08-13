import type { ErrorType } from "@cordierite/shared";

import { DaemonRpcError, isDaemonUnreachableError } from "./rpc/client.js";
import type { CliError, CliErrorType } from "./cli/result-types.js";

const EXIT_CODE_BY_ERROR_TYPE: Record<CliErrorType, number> = {
  usage_error: 64,
  validation_error: 65,
  // EX_NOINPUT (66): "an input file did not exist or was not readable" — `doctor` throws this for a
  // missing external tool or an unreadable/corrupt artifact, deliberately distinct from every other
  // code here so a release pipeline can't mistake "we couldn't tell" for either a clean pass or an
  // assertion failure (docs/tasks/08-cordierite-doctor.md).
  inspection_error: 66,
  connection_error: 70,
  session_error: 71,
  tool_error: 72,
  permission_error: 77,
  internal_error: 1,
  // `doctor --assert-present`/`--assert-absent`: the artifact was inspected successfully and the
  // assertion did not hold. Distinct from `inspection_error` (66) — this means the answer is known
  // and it's "no", not "couldn't tell" — and distinct from `internal_error` (1) so a caller can't
  // conflate a normal assertion failure with an unexpected crash.
  assertion_error: 3,
};

/**
 * Maps the daemon's wire `error.data.type` (ARCHITECTURE.md §5) onto a sysexits class for exit-code
 * purposes only — the CLI error's rendered `type` field still preserves the wire type verbatim
 * (see {@link toCliError}); this table never leaks into rendered output.
 */
const RPC_ERROR_EXIT_CLASS: Record<ErrorType, CliErrorType> = {
  no_session: "session_error",
  ambiguous_session: "session_error",
  unknown_session: "session_error",
  session_not_active: "session_error",
  session_suspended: "session_error",
  tool_not_found: "tool_error",
  tool_input_validation_error: "tool_error",
  tool_output_validation_error: "tool_error",
  tool_execution_error: "tool_error",
  tool_serialization_error: "tool_error",
  tool_timeout: "tool_error",
  policy_denied: "permission_error",
  invalid_request: "validation_error",
};

export class CordieriteCliError extends Error {
  readonly type: CliErrorType;
  readonly details?: unknown;

  constructor(type: CliErrorType, message: string, details?: unknown) {
    super(message);
    this.name = "CordieriteCliError";
    this.type = type;
    this.details = details;
  }
}

export const usageError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("usage_error", message, details);
};

export const validationError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("validation_error", message, details);
};

export const connectionError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("connection_error", message, details);
};

export const sessionError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("session_error", message, details);
};

export const toolError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("tool_error", message, details);
};

export const permissionError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("permission_error", message, details);
};

export const internalError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("internal_error", message, details);
};

export const inspectionError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("inspection_error", message, details);
};

export const assertionError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("assertion_error", message, details);
};

export const isCordieriteCliError = (value: unknown): value is CordieriteCliError => {
  return value instanceof CordieriteCliError;
};

/** True for a `DaemonRpcError` whose `data.type` is a known wire `ErrorType` (always the case for
 * `RpcApplicationError`-originated failures; JSON-RPC transport-level errors like "Method not
 * found" carry no `data` and fall through to `internal_error`). */
const rpcErrorClass = (error: DaemonRpcError): CliErrorType | undefined => {
  const type = error.data?.type;
  return type ? RPC_ERROR_EXIT_CLASS[type] : undefined;
};

/**
 * Converts any error thrown from a command handler into the CLI's rendered `CliError` shape.
 * RPC/app-originated failures (`DaemonRpcError` with a preserved `data.type`) keep that type
 * **verbatim** in `type` — never re-wrapped under a generic bucket (ARCHITECTURE.md §5) — so e.g.
 * `invoke --json` on a failing tool call renders `error.type === "tool_execution_error"`, not
 * `"tool_error"`. `getExitCodeForError` still buckets that same error into a sysexits class.
 */
export const toCliError = (error: unknown): CliError => {
  if (isCordieriteCliError(error)) {
    return {
      type: error.type,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof DaemonRpcError && error.data?.type) {
    return {
      type: error.data.type,
      message: error.message,
      details: error.data.details,
    };
  }

  if (isDaemonUnreachableError(error)) {
    return {
      type: "connection_error",
      message: error instanceof Error ? error.message : "The Cordierite daemon is unreachable.",
    };
  }

  if (error instanceof Error) {
    return {
      type: "internal_error",
      message: error.message,
    };
  }

  return {
    type: "internal_error",
    message: "An unexpected error occurred.",
    details: error,
  };
};

/** Computes the process exit code for the *original* thrown error (not the rendered `CliError`) so
 * that the sysexits classification never depends on — or leaks into — the rendered `type` field. */
export const getExitCodeForError = (error: unknown): number => {
  if (isCordieriteCliError(error)) {
    return EXIT_CODE_BY_ERROR_TYPE[error.type];
  }

  if (error instanceof DaemonRpcError) {
    const cliErrorClass = rpcErrorClass(error);
    return EXIT_CODE_BY_ERROR_TYPE[cliErrorClass ?? "internal_error"];
  }

  if (isDaemonUnreachableError(error)) {
    return EXIT_CODE_BY_ERROR_TYPE.connection_error;
  }

  return EXIT_CODE_BY_ERROR_TYPE.internal_error;
};
