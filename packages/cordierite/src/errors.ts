import type { CliError, CliErrorType } from "@cordierite/shared";

const EXIT_CODE_BY_ERROR_TYPE: Record<CliErrorType, number> = {
  usage_error: 64,
  validation_error: 65,
  connection_error: 70,
  session_error: 71,
  tool_error: 72,
  internal_error: 1,
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

export const internalError = (message: string, details?: unknown): CordieriteCliError => {
  return new CordieriteCliError("internal_error", message, details);
};

export const isCordieriteCliError = (value: unknown): value is CordieriteCliError => {
  return value instanceof CordieriteCliError;
};

export const toCliError = (error: unknown): CliError => {
  if (isCordieriteCliError(error)) {
    return {
      type: error.type,
      message: error.message,
      details: error.details,
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

export const getExitCodeForError = (error: CliError): number => {
  return EXIT_CODE_BY_ERROR_TYPE[error.type];
};
