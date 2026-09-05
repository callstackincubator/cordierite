import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { runCliBinary, runCliWithCapture } from "./fixtures.js";

describe("CLI integration", () => {
  test("keygen --out --json is non-interactive and works with stdin/stdout not a TTY", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-integration-"));
    const keyPath = path.join(directory, "generated-key.pem");

    try {
      const result = await runCliWithCapture(["keygen", "--out", keyPath, "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        ok: true,
        data: {
          path: keyPath,
        },
      });
      expect(parsed.data.pin).toMatch(/^sha256\//u);
      expect(await readFile(keyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("help lists exactly the v2 command surface (ARCHITECTURE.md §10)", () => {
    const command = runCliBinary(["--help"]);

    expect(command.exitCode).toBe(0);

    const stdout = command.stdout;
    const commandsSection = stdout.split(/\n\s*\n/u).find((block) => block.startsWith("Commands:"));

    expect(commandsSection).toBeDefined();

    const commandNames = commandsSection!
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim().split(/\s{2,}/u)[0]);

    // Exactly the v2 command surface (ARCHITECTURE.md §10, plus `mcp` from §9) — v1's
    // `host`/`connect`/`session` commands must never resurface here.
    expect(new Set(commandNames)).toEqual(
      new Set([
        "init",
        "keygen",
        "link",
        "ls",
        "tools [selector] [name]",
        "invoke [selector] [tool]",
        "events [selector]",
        "revoke [selector]",
        "mcp",
        "doctor <artifact>",
        "daemon [action]",
      ]),
    );
  });

  test("--help on each command exposes exactly its documented flags", () => {
    const helpFor = (command: string): string => {
      const result = runCliBinary([command, "--help"]);
      expect(result.exitCode).toBe(0);
      return result.stdout;
    };

    const initHelp = helpFor("init");
    expect(initHelp).toContain("--scheme");
    expect(initHelp).toContain("--force");

    const keygenHelp = helpFor("keygen");
    expect(keygenHelp).toContain("--out");
    expect(keygenHelp).toContain("--force");

    const linkHelp = helpFor("link");
    expect(linkHelp).toContain("--ttl");
    expect(linkHelp).toContain("--qr");
    expect(linkHelp).toContain("--scheme");
    expect(linkHelp).toContain("--open");

    const toolsHelp = helpFor("tools");
    expect(toolsHelp).toContain("--full");

    const invokeHelp = helpFor("invoke");
    expect(invokeHelp).toContain("--input");
    expect(invokeHelp).toContain("--timeout");

    const eventsHelp = helpFor("events");
    expect(eventsHelp).toContain("--follow");

    // Issue #29: an MCP config entry has to be able to carry its own scheme.
    const mcpHelp = helpFor("mcp");
    expect(mcpHelp).toContain("--scheme");

    const doctorHelp = helpFor("doctor");
    expect(doctorHelp).toContain("--assert-present");
    expect(doctorHelp).toContain("--assert-absent");
  });

  test("version is available from the binary entrypoint", () => {
    const command = runCliBinary(["--version"]);

    expect(command.exitCode).toBe(0);
  });
});
