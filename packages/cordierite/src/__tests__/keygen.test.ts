import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { handleKeygenCommand } from "../commands/keygen.js";

describe("keygen command", () => {
  test("writes a private key at --out and returns its path and fingerprint", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-"));
    const keyPath = path.join(directory, "host-key.pem");

    try {
      const result = await handleKeygenCommand({ out: keyPath }, { stateDir: directory });

      expect(result).toMatchObject({
        ok: true,
        data: {
          path: keyPath,
        },
      });
      expect(result.ok && result.data.pin).toMatch(/^sha256\//u);
      expect(await readFile(keyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("defaults to <state-dir>/key.pem when --out is omitted", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-"));

    try {
      const result = await handleKeygenCommand({}, { stateDir: directory });

      expect(result.ok && result.data.path).toBe(path.join(directory, "key.pem"));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("refuses to overwrite an existing key without --force", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-"));
    const keyPath = path.join(directory, "host-key.pem");

    try {
      await handleKeygenCommand({ out: keyPath }, { stateDir: directory });

      await expect(handleKeygenCommand({ out: keyPath }, { stateDir: directory })).rejects.toMatchObject({
        type: "usage_error",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("overwrites an existing key with --force", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-"));
    const keyPath = path.join(directory, "host-key.pem");

    try {
      const first = await handleKeygenCommand({ out: keyPath }, { stateDir: directory });
      const second = await handleKeygenCommand({ out: keyPath, force: true }, { stateDir: directory });

      expect(first.ok && second.ok && first.data.pin).not.toBe(second.ok && second.data.pin);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("creates missing parent directories for --out", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cordierite-keygen-"));
    const keyPath = path.join(directory, "nested", "deeper", "host-key.pem");

    try {
      const result = await handleKeygenCommand({ out: keyPath }, { stateDir: directory });

      expect(result.ok).toBe(true);
      expect(await readFile(keyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
