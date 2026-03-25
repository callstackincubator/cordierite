import path from "node:path";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { getSpkiPinFromPrivateKeyPem } from "../spki-pin.js";

const playgroundKeyPath = path.resolve(import.meta.dirname, "../../../../playground/certs/dev-key.pem");

describe("SPKI pin helper", () => {
  test("derives the expected pin from known key material", () => {
    const keyPem = readFileSync(playgroundKeyPath, "utf8");

    expect(getSpkiPinFromPrivateKeyPem(keyPem)).toBe("sha256/aHDJIGvOJjRr3K9qmqmw3FQ6KWx+wWgEpKVLDbxmyhY=");
  });
});
