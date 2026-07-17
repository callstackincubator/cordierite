/**
 * Host private-key generation and atomic persistence (ARCHITECTURE.md §3, §10). Shared by
 * `cordierite keygen` (explicit, user-invoked) and the daemon's zero-config dev-mode
 * auto-generation at startup (`daemon/tls.ts`) — both call sites need byte-identical key material
 * (RSA-2048, PKCS8 PEM) and identical file hygiene (0600, atomic rename via a `wx`-flagged temp
 * file so a concurrent writer can never observe a partial key).
 */

import { generateKeyPairSync } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";

export const generatePrivateKeyPem = (): string => {
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

/** Writes `keyPem` at `path` atomically (temp file + rename) with mode 0600. The temp file uses
 * `wx` so two concurrent writers can never interleave; callers that want to overwrite an existing
 * `path` still succeed, since `rename` replaces the destination on POSIX regardless of whether it
 * already existed — only the *temp* path must be exclusive. */
export const writePrivateKeyAtomically = async (path: string, keyPem: string): Promise<void> => {
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
