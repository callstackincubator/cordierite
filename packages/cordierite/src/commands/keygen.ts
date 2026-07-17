/**
 * `cordierite keygen` (ARCHITECTURE.md §10): fully non-interactive — v1's TTY-only prompt flow made
 * it unusable in CI/agent contexts, and neither ARCHITECTURE.md nor the v2 command table describe
 * any interactive mode, so it is not carried forward. Default output is `<state-dir>/key.pem`,
 * the same path the daemon's TLS listener loads by default (ARCHITECTURE.md §3).
 *
 * Since opt-in hardening, this is no longer the *only* way to get a key: the daemon now
 * auto-generates one at this same default path if it's missing at startup (dev-mode zero-config
 * bootstrap — `daemon/tls.ts`). `keygen` remains for explicit key management (rotation via
 * `--force`, a non-default `--out`, or CI/scripted provisioning ahead of a release build).
 * Key generation/file-hygiene itself is shared with the daemon's auto-generate path via
 * `key-material.ts` so both produce byte-identical material.
 */

import { stat } from "node:fs/promises";

import type { CliResult, KeygenCommandData } from "../cli/result-types.js";

import { getStateDirPaths } from "../daemon/state-dir.js";
import { usageError } from "../errors.js";
import { generatePrivateKeyPem, writePrivateKeyAtomically } from "../key-material.js";
import { getSpkiPinFromPrivateKeyPem } from "../spki-pin.js";

export type KeygenCommandOptions = {
  out?: string;
  force?: boolean;
};

export type KeygenCommandContext = {
  stateDir: string;
};

export const handleKeygenCommand = async (
  options: KeygenCommandOptions,
  context: KeygenCommandContext,
): Promise<CliResult<KeygenCommandData>> => {
  const outputPath = options.out ?? getStateDirPaths(context.stateDir).keyPath;

  if (!options.force) {
    let exists = true;

    try {
      await stat(outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      exists = false;
    }

    if (exists) {
      throw usageError(`Refusing to overwrite an existing key at "${outputPath}" without --force.`);
    }
  }

  const keyPem = generatePrivateKeyPem();
  const pin = getSpkiPinFromPrivateKeyPem(keyPem);

  await writePrivateKeyAtomically(outputPath, keyPem);

  return {
    ok: true,
    data: {
      path: outputPath,
      pin,
    },
  };
};
