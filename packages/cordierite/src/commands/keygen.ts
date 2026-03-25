import { generateKeyPairSync } from "node:crypto";
import { dirname, resolve } from "node:path";
import { rename, rm, stat, writeFile } from "node:fs/promises";

import type { CliResult, KeygenCommandData } from "@cordierite/shared";

import { internalError, usageError } from "../errors.js";
import { createPromptSession, ensureInteractivePromptInput, type PromptIo } from "../prompts.js";
import { getSpkiPinFromPrivateKeyPem } from "../spki-pin.js";

const DEFAULT_KEY_PATH = "./cordierite-key.pem";

export type KeygenCommandContext = {
  prompt: PromptIo;
};

const emitPromptMessage = (output: NodeJS.WritableStream, message: string): void => {
  output.write(`${message}\n`);
};

const resolveKeyOutputPath = async (
  prompts: ReturnType<typeof createPromptSession>,
  output: NodeJS.WritableStream,
): Promise<string> => {
  while (true) {
    const answer = await prompts.question(`Destination path [${DEFAULT_KEY_PATH}]: `);
    const normalizedAnswer = answer.trim();
    const selectedPath = answer === "" ? DEFAULT_KEY_PATH : normalizedAnswer;

    if (selectedPath.length === 0) {
      emitPromptMessage(output, "Please enter a path.");
      continue;
    }

    const absolutePath = resolve(selectedPath);
    const parentDirectory = dirname(absolutePath);

    try {
      const directoryStats = await stat(parentDirectory);

      if (!directoryStats.isDirectory()) {
        emitPromptMessage(output, `Parent path is not a directory: ${parentDirectory}`);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        emitPromptMessage(output, `Directory does not exist: ${parentDirectory}`);
        continue;
      }

      throw internalError("Unable to validate the destination path for the Cordierite key.", {
        cause: error,
        path: absolutePath,
      });
    }

    let existingPathStats: Awaited<ReturnType<typeof stat>>;

    try {
      existingPathStats = await stat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return absolutePath;
      }

      throw internalError("Unable to inspect the destination path for the Cordierite key.", {
        cause: error,
        path: absolutePath,
      });
    }

    if (existingPathStats.isDirectory()) {
      emitPromptMessage(output, `Destination path is a directory: ${absolutePath}`);
      continue;
    }

    while (true) {
      const overwrite = (await prompts.question(`File exists. Overwrite ${absolutePath}? [y/N]: `))
        .trim()
        .toLowerCase();

      if (overwrite === "" || overwrite === "n" || overwrite === "no") {
        throw usageError("Key generation cancelled because the destination file already exists.");
      }

      if (overwrite === "y" || overwrite === "yes") {
        return absolutePath;
      }

      emitPromptMessage(output, "Please answer yes or no.");
    }
  }
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

  try {
    await writeFile(temporaryPath, keyPem, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});

    throw internalError("Failed to write the Cordierite private key.", {
      cause: error,
      path,
    });
  }
};

export const handleKeygenCommand = async (
  _options: Record<string, never>,
  context: KeygenCommandContext,
): Promise<CliResult<KeygenCommandData>> => {
  ensureInteractivePromptInput("keygen", context.prompt.input);

  const prompts = createPromptSession(context.prompt);

  try {
    const outputPath = await resolveKeyOutputPath(prompts, context.prompt.output);
    const keyPem = generatePrivateKeyPem();
    const spkiPin = getSpkiPinFromPrivateKeyPem(keyPem);

    await writePrivateKeyAtomically(outputPath, keyPem);

    return {
      ok: true,
      data: {
        key: {
          path: outputPath,
          spki_pin: spkiPin,
          algorithm: "rsa-2048",
        },
      },
    };
  } finally {
    prompts.close();
  }
};
