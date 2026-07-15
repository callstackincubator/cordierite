import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { getSpkiPinFromPrivateKeyPem } from "../spki-pin.js";

describe("SPKI pin helper", () => {
  test("derives a stable sha256 pin from freshly generated key material", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

    const pin = getSpkiPinFromPrivateKeyPem(keyPem);

    expect(pin).toMatch(/^sha256\/[A-Za-z0-9+/]+=*$/u);
    // Deterministic for the same key material.
    expect(getSpkiPinFromPrivateKeyPem(keyPem)).toBe(pin);
  });

  test("differs for different keys and matches an independently derived SPKI digest", () => {
    const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const second = generateKeyPairSync("rsa", { modulusLength: 2048 });

    const firstPem = first.privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");
    const secondPem = second.privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

    expect(getSpkiPinFromPrivateKeyPem(firstPem)).not.toBe(getSpkiPinFromPrivateKeyPem(secondPem));

    const publicKey = createPublicKey(createPrivateKey(firstPem));
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    const expectedPin = `sha256/${createHash("sha256").update(spkiDer).digest("base64")}`;

    expect(getSpkiPinFromPrivateKeyPem(firstPem)).toBe(expectedPin);
  });
});
