import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { binEntry, createInteractiveInput, packageRoot, runCliWithCapture } from "./fixtures.js";

describe("CLI integration", () => {
  test("keygen --json emits generated key metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-integration-"));
    const keyPath = path.join(directory, "generated-key.pem");

    try {
      const result = await runCliWithCapture(
        ["keygen", "--json"],
        {
          stdin: createInteractiveInput(`${keyPath}\n`),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Destination path");

      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        ok: true,
        data: {
          key: {
            path: keyPath,
            algorithm: "rsa-2048",
          },
        },
      });
      expect(parsed.data.key.spki_pin).toMatch(/^sha256\//u);
      expect(await readFile(keyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("help is available from the binary entrypoint and lists only keygen", () => {
    const command = Bun.spawnSync({
      cmd: ["bun", binEntry, "--help"],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(command.exitCode).toBe(0);

    const stdout = command.stdout.toString("utf8");
    const commandsSection = stdout.split(/\n\s*\n/u).find((block) => block.startsWith("Commands:"));

    expect(commandsSection).toBeDefined();
    expect(commandsSection).toContain("keygen");
    expect(commandsSection?.trim().split("\n")).toHaveLength(2);
    expect(stdout).not.toMatch(/\bconnect\b|\bsession\b|\binvoke\b/u);
  });

  test("version is available from the binary entrypoint", () => {
    const command = Bun.spawnSync({
      cmd: ["bun", binEntry, "--version"],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(command.exitCode).toBe(0);
  });
});
