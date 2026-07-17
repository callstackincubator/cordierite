/**
 * Dev-mode zero-config bootstrap (opt-in hardening): `createTlsManager`/`loadOrGenerateHostKeyPem`
 * must no longer require a pre-existing key file. These are direct unit tests against `tls.ts`;
 * `tls-refresh.integration.test.ts` covers the full daemon-startup path with a pre-written key.
 */

import path from "node:path";
import { tmpdir } from "node:os";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { createTlsManager, HostKeyError, loadHostKeyPem, loadOrGenerateHostKeyPem } from "../daemon/tls.js";
import { getSpkiPinFromPrivateKeyPem } from "../spki-pin.js";
import { writeTestHostKey } from "./fixtures.js";

const stateDirs: string[] = [];

afterEach(async () => {
  while (stateDirs.length > 0) {
    await rm(stateDirs.pop()!, { force: true, recursive: true });
  }
});

const makeStateDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "cordierite-tls-"));
  stateDirs.push(directory);
  return directory;
};

describe("loadOrGenerateHostKeyPem", () => {
  test("generates a key at 0600 and warns with its fingerprint when none exists", async () => {
    const stateDir = await makeStateDir();
    const keyPath = path.join(stateDir, "key.pem");
    const warnings: string[] = [];

    const keyPem = await loadOrGenerateHostKeyPem(keyPath, (message) => warnings.push(message));

    expect(keyPem).toContain("BEGIN PRIVATE KEY");
    expect(await readFile(keyPath, "utf8")).toBe(keyPem);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);

    const expectedPin = getSpkiPinFromPrivateKeyPem(keyPem);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(expectedPin);
    expect(warnings[0]).toContain(keyPath);
  });

  test("loads an existing key unchanged and never warns", async () => {
    const stateDir = await makeStateDir();
    const keyPath = path.join(stateDir, "key.pem");
    await writeTestHostKey(keyPath);
    const before = await readFile(keyPath, "utf8");

    const warnings: string[] = [];
    const keyPem = await loadOrGenerateHostKeyPem(keyPath, (message) => warnings.push(message));

    expect(keyPem).toBe(before);
    expect(warnings).toHaveLength(0);
  });

  test("does not silently regenerate a key with bad permissions — still throws HostKeyError", async () => {
    const stateDir = await makeStateDir();
    const keyPath = path.join(stateDir, "key.pem");
    await writeTestHostKey(keyPath);
    await chmod(keyPath, 0o644);

    await expect(loadOrGenerateHostKeyPem(keyPath)).rejects.toBeInstanceOf(HostKeyError);
  });

  test("works with no warn callback provided", async () => {
    const stateDir = await makeStateDir();
    const keyPath = path.join(stateDir, "key.pem");

    await expect(loadOrGenerateHostKeyPem(keyPath)).resolves.toContain("BEGIN PRIVATE KEY");
  });
});

describe("loadHostKeyPem", () => {
  test("propagates a raw ENOENT (auto-generation is the caller's job, not this function's)", async () => {
    const stateDir = await makeStateDir();
    const keyPath = path.join(stateDir, "key.pem");

    await expect(loadHostKeyPem(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("createTlsManager", () => {
  test("auto-generates a missing key and its pinnedKeys() matches the generated key's fingerprint", async () => {
    const stateDir = await makeStateDir();
    const keyPath = path.join(stateDir, "key.pem");
    const warnings: string[] = [];

    const tls = await createTlsManager({
      keyPath,
      detectAddress: () => ({ family: 4, address: "127.0.0.1" }),
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(1);
    const [pin] = tls.pinnedKeys();
    expect(pin).toBeDefined();
    expect(warnings[0]).toContain(pin!);
    expect(await readFile(keyPath, "utf8")).toBe(tls.current().keyPem);
  });
});
