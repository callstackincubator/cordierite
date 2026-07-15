/**
 * Small option-parsing helpers shared across the v2 command handlers wired in `dispatch.ts`. Kept
 * separate from `dispatch.ts` itself so each parsing rule (numeric flags, the selector/target
 * positional split) has one obvious place to test in isolation.
 */

import { usageError, validationError } from "../errors.js";

/** Parses a `cac`-provided option value (already a number, a numeric string, or `undefined`) into a
 * positive integer, or throws a clear `usage_error`. */
export const parsePositiveIntegerOption = (value: unknown, flagName: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`"${flagName}" must be a positive integer.`);
  }

  return parsed;
};

/**
 * Splits the positional args of a command shaped `<command> [selector] <target>` (e.g. `invoke
 * [selector] <tool>`, `tools [selector] <name>`): the last positional is always the required
 * target, everything before it (zero or one args) is the optional selector.
 */
export const splitSelectorAndRequiredTarget = (
  args: readonly string[],
  commandUsage: string,
): { selector?: string; target: string } => {
  if (args.length === 0) {
    throw usageError(`Usage: ${commandUsage}`);
  }

  if (args.length > 2) {
    throw usageError(`Usage: ${commandUsage} (too many arguments).`);
  }

  if (args.length === 1) {
    return { target: args[0]! };
  }

  return { selector: args[0], target: args[1]! };
};

/** Splits the positional args of a command shaped `<command> [selector]`: at most one positional,
 * the optional selector. */
export const splitOptionalSelector = (args: readonly string[], commandUsage: string): { selector?: string } => {
  if (args.length > 1) {
    throw usageError(`Usage: ${commandUsage} (too many arguments).`);
  }

  return { selector: args[0] };
};

/**
 * Splits the positional args of a command shaped `<command> [selector] [target]` (`tools [selector]
 * [name]`): with 2 args, `(selector, target)`; with 1, the single arg is ambiguous between "the
 * selector" and "the target with the selector omitted" — the caller resolves that (see
 * `commands/tools.ts`), so it comes back unlabeled here as `selectorOrTarget`.
 */
export const splitOptionalSelectorAndTarget = (
  args: readonly string[],
  commandUsage: string,
): { selector?: string; target?: string; selectorOrTarget?: string } => {
  if (args.length > 2) {
    throw usageError(`Usage: ${commandUsage} (too many arguments).`);
  }

  if (args.length === 2) {
    return { selector: args[0], target: args[1] };
  }

  if (args.length === 1) {
    return { selectorOrTarget: args[0] };
  }

  return {};
};

/**
 * Parses the JSON payload for `invoke --input`; never throws a raw `SyntaxError` at the CLI
 * boundary. A missing flag is a usage error (nothing was given); a present-but-unparseable or
 * wrong-shaped value is a validation error (something was given, and it's invalid).
 */
export const parseJsonInputOption = (value: string | undefined): Record<string, unknown> => {
  if (value === undefined) {
    throw usageError('"--input" is required.');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw validationError(`"--input" must be valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw validationError('"--input" must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
};
