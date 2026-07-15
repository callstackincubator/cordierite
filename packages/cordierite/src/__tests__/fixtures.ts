import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { runCli } from "../cli.js";

export const FIXED_NOW = new Date("2026-03-17T10:00:00.000Z");

export const fixedClock = {
  now: () => FIXED_NOW,
};

/** Package root: `packages/cordierite` (this file lives in `src/__tests__`). */
export const packageRoot = path.resolve(import.meta.dirname, "..", "..");

export const binEntry = path.join(packageRoot, "src/bin.ts");

export const createInteractiveInput = (
  text: string,
): NodeJS.ReadableStream & {
  isTTY: boolean;
} => {
  const input = new PassThrough();
  const chunks = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [text];

  queueMicrotask(() => {
    for (const [index, chunk] of chunks.entries()) {
      setTimeout(() => {
        input.write(chunk);

        if (index === chunks.length - 1) {
          input.end();
        }
      }, index);
    }

    if (chunks.length === 0) {
      input.end();
    }
  });

  return Object.assign(input, {
    isTTY: true,
  });
};

type RunCliCaptureOptions = {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  promptOutput?: NodeJS.WritableStream;
  stdoutIsTTY?: boolean;
};

export const runCliWithCapture = async (
  argv: string[],
  options: RunCliCaptureOptions = {},
) => {
  let stdout = "";
  let stderr = "";
  const promptOutput =
    options.promptOutput ??
    new Writable({
      write(chunk, _encoding, callback) {
        stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        callback();
      },
    });

  const exitCode = await runCli(argv, {
    clock: fixedClock,
    stdin: options.stdin,
    promptOutput,
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
