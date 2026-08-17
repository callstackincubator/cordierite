/**
 * Unit coverage for the exit-code mapping: the daemon's wire `ErrorType`s
 * (ARCHITECTURE.md §5) bucket onto the sysexits-style classes in `errors.ts`, while `toCliError`'s
 * rendered `type` field preserves the wire type verbatim (never the bucket name) — the full
 * round-trip through a real daemon is covered by `tool-invocation.integration.test.ts`-style flows
 * in `cli-v2.integration.test.ts`; this file pins the mapping table itself.
 */
import { describe, expect, test } from "vitest";

import { ERROR_TYPES, type ErrorType } from "@cordierite/shared";

import {
  assertionError,
  getExitCodeForError,
  inspectionError,
  internalError,
  permissionError,
  sessionError,
  toCliError,
  toolError,
  usageError,
  validationError,
} from "../errors.js";
import { DaemonRpcError, DaemonUnavailableError } from "../rpc/client.js";

const EXPECTED_RPC_ERROR_CLASS: Record<ErrorType, number> = {
  no_session: 71,
  ambiguous_session: 71,
  unknown_session: 71,
  session_not_active: 71,
  session_suspended: 71,
  tool_not_found: 72,
  tool_input_validation_error: 72,
  tool_output_validation_error: 72,
  tool_execution_error: 72,
  tool_serialization_error: 72,
  tool_timeout: 72,
  policy_denied: 77,
  invalid_request: 65,
};

describe("getExitCodeForError: CLI-originated errors", () => {
  test.each([
    [usageError("bad flag"), 64],
    [validationError("bad json"), 65],
    [sessionError("no session"), 71],
    [toolError("tool failed"), 72],
    [permissionError("denied"), 77],
    [internalError("boom"), 1],
    [inspectionError("no unzip on PATH"), 66],
    [assertionError("expected present, got absent"), 3],
  ] as const)("%s -> exit %i", (error, expectedCode) => {
    expect(getExitCodeForError(error)).toBe(expectedCode);
    expect(toCliError(error).type).toBe(error.type);
  });

  test("inspection_error and assertion_error are distinct exit codes from each other and from every other class", () => {
    const codes = [
      getExitCodeForError(usageError("x")),
      getExitCodeForError(validationError("x")),
      getExitCodeForError(sessionError("x")),
      getExitCodeForError(toolError("x")),
      getExitCodeForError(permissionError("x")),
      getExitCodeForError(internalError("x")),
      getExitCodeForError(inspectionError("x")),
      getExitCodeForError(assertionError("x")),
    ];

    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("getExitCodeForError: RPC wire errors preserve type but bucket the exit code", () => {
  test.each(ERROR_TYPES.map((type) => [type] as const))("wire type %s", (type) => {
    const error = new DaemonRpcError(-32000, `boom: ${type}`, { type });

    expect(getExitCodeForError(error)).toBe(EXPECTED_RPC_ERROR_CLASS[type]);

    const cliError = toCliError(error);
    expect(cliError.type).toBe(type);
    expect(cliError.message).toBe(`boom: ${type}`);
  });

  test("a transport-level JSON-RPC error with no data.type falls back to internal_error", () => {
    const error = new DaemonRpcError(-32601, "Method not found");

    expect(getExitCodeForError(error)).toBe(1);
    expect(toCliError(error).type).toBe("internal_error");
  });
});

describe("getExitCodeForError: daemon-unreachable errors", () => {
  test("DaemonUnavailableError maps to connection_error (70)", () => {
    const error = new DaemonUnavailableError("Connection to the Cordierite daemon closed.");

    expect(getExitCodeForError(error)).toBe(70);
    expect(toCliError(error).type).toBe("connection_error");
  });

  test("ENOENT/ECONNREFUSED (no daemon at all) also maps to connection_error (70)", () => {
    const error = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });

    expect(getExitCodeForError(error)).toBe(70);
    expect(toCliError(error).type).toBe("connection_error");
  });
});

describe("getExitCodeForError: unknown errors", () => {
  test("a plain Error not otherwise recognized maps to internal_error (1)", () => {
    expect(getExitCodeForError(new Error("mystery"))).toBe(1);
    expect(getExitCodeForError("not even an Error")).toBe(1);
  });
});
