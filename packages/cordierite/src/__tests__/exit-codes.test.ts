import { describe, expect, test } from "bun:test";

import { getExitCodeForError } from "../errors.js";

describe("exit code mapping", () => {
  test("typed errors map to stable shell exit codes", () => {
    expect(
      getExitCodeForError({
        type: "usage_error",
        message: "x",
      }),
    ).toBe(64);
    expect(
      getExitCodeForError({
        type: "validation_error",
        message: "x",
      }),
    ).toBe(65);
    expect(
      getExitCodeForError({
        type: "connection_error",
        message: "x",
      }),
    ).toBe(70);
    expect(
      getExitCodeForError({
        type: "session_error",
        message: "x",
      }),
    ).toBe(71);
    expect(
      getExitCodeForError({
        type: "tool_error",
        message: "x",
      }),
    ).toBe(72);
  });
});
