import { createInterface } from "node:readline/promises";

import { usageError } from "./errors.js";

export type PromptIo = {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
};

export const ensureInteractivePromptInput = (
  command: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean },
): void => {
  if (input.isTTY !== true) {
    throw usageError(`The ${command} command requires an interactive TTY on stdin.`);
  }
};

export const createPromptSession = (io: PromptIo) => {
  const readline = createInterface({
    input: io.input,
    output: io.output,
    terminal: false,
  });

  return {
    async question(prompt: string): Promise<string> {
      return readline.question(prompt);
    },
    close(): void {
      readline.close();
    },
  };
};
