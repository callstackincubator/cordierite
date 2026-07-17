import { generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import { runCli } from "../cli.js";

export const FIXED_NOW = new Date("2026-03-17T10:00:00.000Z");

export const fixedClock = {
  now: () => FIXED_NOW,
};

/** Package root: `packages/cordierite` (this file lives in `src/__tests__`). */
export const packageRoot = path.resolve(import.meta.dirname, "..", "..");

export const binEntry = path.join(packageRoot, "bin.js");

type CliProcessOptions = {
  stateDir?: string;
  extraEnv?: NodeJS.ProcessEnv;
};

const cliEnvironment = ({ stateDir, extraEnv }: CliProcessOptions): NodeJS.ProcessEnv => ({
  ...process.env,
  ...extraEnv,
  ...(stateDir ? { CORDIERITE_STATE_DIR: stateDir } : {}),
});

/** Runs the built Node CLI as a subprocess, mirroring the published executable. */
export const runCliBinary = (args: string[], options: CliProcessOptions = {}) => {
  const result = spawnSync(process.execPath, [binEntry, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: cliEnvironment(options),
  });

  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
};

/** Starts the built Node CLI without waiting for it to exit. */
export const spawnCliBinary = (
  args: string[],
  options: CliProcessOptions = {},
): ChildProcessByStdio<null, Readable, Readable> => {
  return spawn(process.execPath, [binEntry, ...args], {
    cwd: packageRoot,
    env: cliEnvironment(options),
    stdio: ["ignore", "pipe", "pipe"],
  });
};

export const waitForExit = (
  process: ChildProcessByStdio<null, Readable, Readable>,
): Promise<number> => {
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code) => resolve(code ?? 1));
  });
};

/**
 * Generates a throwaway EC host key directly into a temp state dir with mode 0600 — the daemon's
 * TLS listener (daemon/tls.ts) refuses to start without one. Never used outside test runtime; the
 * key is never committed (LOOP.md: "test keys are generated at test runtime into temp dirs").
 */
export const writeTestHostKey = async (keyPath: string): Promise<void> => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

  await writeFile(keyPath, pem, { encoding: "utf8", mode: 0o600 });
};

type RunCliCaptureOptions = {
  stdoutIsTTY?: boolean;
};

export const runCliWithCapture = async (
  argv: string[],
  options: RunCliCaptureOptions = {},
) => {
  let stdout = "";
  let stderr = "";

  const exitCode = await runCli(argv, {
    clock: fixedClock,
    stdout: {
      isTTY: options.stdoutIsTTY ?? false,
      write(chunk: string | Uint8Array) {
        stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    },
  });

  return {
    exitCode,
    stdout,
    stderr,
  };
};
