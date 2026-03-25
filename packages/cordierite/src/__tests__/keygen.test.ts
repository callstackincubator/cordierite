import path from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { handleKeygenCommand } from "../commands/keygen.js";

const createPromptOutput = (sink: { text: string }): NodeJS.WritableStream => {
  return new Writable({
    write(chunk, _encoding, callback) {
      sink.text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      callback();
    },
  });
};

const waitForText = async (sink: { text: string }, text: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sink.text.includes(text)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for prompt text: ${text}`);
};

const createInput = (
  text: string,
  isTTY: boolean,
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
    isTTY,
  });
};

describe("keygen command", () => {
  test("writes a private key and returns its fingerprint", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-"));
    const keyPath = path.join(directory, "host-key.pem");
    const output = { text: "" };

    try {
      const result = await handleKeygenCommand(
        {},
        {
          prompt: {
            input: createInput(`${keyPath}\n`, true),
            output: createPromptOutput(output),
          },
        },
      );

      expect(result).toMatchObject({
        ok: true,
        data: {
          key: {
            path: keyPath,
            algorithm: "rsa-2048",
          },
        },
      });
      expect(result.ok && result.data.key.spki_pin).toMatch(/^sha256\//u);
      expect(await readFile(keyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
      expect(output.text).toContain("Destination path");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("fails cleanly when stdin is not interactive", async () => {
    await expect(
      handleKeygenCommand(
        {},
        {
          prompt: {
            input: createInput("", false),
            output: createPromptOutput({ text: "" }),
          },
        },
      ),
    ).rejects.toMatchObject({
      type: "usage_error",
      message: "The keygen command requires an interactive TTY on stdin.",
    });
  });

  test("cancels when overwrite is declined", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-"));
    const keyPath = path.join(directory, "existing-key.pem");
    const output = { text: "" };

    try {
      await writeFile(keyPath, "already-here", "utf8");
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
      });
      const pending = handleKeygenCommand(
        {},
        {
          prompt: {
            input,
            output: createPromptOutput(output),
          },
        },
      );

      input.write(`${keyPath}\n`);
      await waitForText(output, "Overwrite");
      input.write("no\n");
      input.end();

      await expect(
        pending,
      ).rejects.toMatchObject({
        type: "usage_error",
        message: "Key generation cancelled because the destination file already exists.",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("re-prompts for blank and invalid paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-"));
    const missingDirectory = path.join(directory, "missing");
    const keyPath = path.join(directory, "final-key.pem");
    const output = { text: "" };

    try {
      const result = await handleKeygenCommand(
        {},
        {
          prompt: {
            input: createInput(`   \n${path.join(missingDirectory, "key.pem")}\n${keyPath}\n`, true),
            output: createPromptOutput(output),
          },
        },
      );

      expect(result).toMatchObject({
        ok: true,
        data: {
          key: {
            path: keyPath,
          },
        },
      });
      expect(output.text).toContain("Please enter a path.");
      expect(output.text).toContain(`Directory does not exist: ${missingDirectory}`);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
