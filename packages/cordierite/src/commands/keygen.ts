/**
 * `cordierite keygen` (ARCHITECTURE.md §10): fully non-interactive — v1's TTY-only prompt flow made
 * it unusable in CI/agent contexts, and neither ARCHITECTURE.md nor the v2 command table describe
 * any interactive mode, so it is not carried forward. Default output is `<state-dir>/key.pem`,
 * the same path the daemon's TLS listener loads by default (ARCHITECTURE.md §3).
 */

import { generateKeyPairSync } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";

import type { CliResult, KeygenCommandData } from "../cli/result-types.js";

import { getStateDirPaths } from "../daemon/state-dir.js";
import { usageError } from "../errors.js";
import { getSpkiPinFromPrivateKeyPem } from "../spki-pin.js";

export type KeygenCommandOptions = {
  out?: string;
  force?: boolean;
};

export type KeygenCommandContext = {
  stateDir: string;
};

const generatePrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });

  return privateKey
    .export({
      format: "pem",
      type: "pkcs8",
    })
    .toString("utf8");
};

const writePrivateKeyAtomically = async (path: string, keyPem: string): Promise<void> => {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(temporaryPath, keyPem, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
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
