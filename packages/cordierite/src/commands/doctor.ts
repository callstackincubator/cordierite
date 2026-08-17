/**
 * `cordierite doctor <artifact>` (docs/tasks/08-cordierite-doctor.md): the release-gate replacement
 * for the runtime `debuggable` check removed elsewhere in opt-in hardening — see
 * `artifact-inspect.ts`'s doc comment for the detection strategy and why it never collapses a
 * missing-tool or unreadable-artifact case into "absent".
 *
 * This handler owns only the CLI-facing concerns: option validation (mutually exclusive
 * `--assert-present`/`--assert-absent`) and turning a failed assertion into a distinct
 * {@link assertionError} exit, separate from `inspectionError`'s "couldn't tell" exit. All artifact
 * inspection itself lives in `artifact-inspect.ts`, unit-testable without going through the CLI.
 */

import type { CliResult, DoctorCommandData } from "../cli/result-types.js";

import { inspectArtifact, type ExecBufferFn } from "../artifact-inspect.js";
import { assertionError, usageError } from "../errors.js";

export type DoctorCommandOptions = {
  artifactPath?: string;
  assertPresent?: boolean;
  assertAbsent?: boolean;
};

export type DoctorCommandContext = {
  exec?: ExecBufferFn;
};

export const handleDoctorCommand = async (
  options: DoctorCommandOptions,
  context: DoctorCommandContext = {},
): Promise<CliResult<DoctorCommandData>> => {
  if (!options.artifactPath) {
    throw usageError("Usage: cordierite doctor <path-to-artifact> [--assert-present | --assert-absent]");
  }

  if (options.assertPresent && options.assertAbsent) {
    throw usageError("--assert-present and --assert-absent are mutually exclusive.");
  }

  const inspection = await inspectArtifact(options.artifactPath, { exec: context.exec });

  const data: DoctorCommandData = {
    artifact: options.artifactPath,
    platform: inspection.platform,
    format: inspection.format,
    present: inspection.present,
    signals: inspection.signals,
  };

  if (options.assertPresent && !inspection.present) {
    throw assertionError(
      `Expected Cordierite to be present in "${options.artifactPath}", but no inclusion signal was found.`,
      data,
    );
  }

  if (options.assertAbsent && inspection.present) {
    throw assertionError(
      `Expected Cordierite to be absent from "${options.artifactPath}", but found: ${inspection.signals.join(", ")}.`,
      data,
    );
  }

  if (options.assertPresent || options.assertAbsent) {
    data.assertion = {
      expected: options.assertPresent ? "present" : "absent",
      holds: true,
    };
  }

  return { ok: true, data };
};
