import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { getSpkiPinFromPrivateKeyPem } from "../spki-pin.js";

const playgroundPath = (path: string): string =>
  fileURLToPath(new URL(`../../../../playground/${path}`, import.meta.url));

describe("playground Cordierite fixture", () => {
  test("pins the committed host key in its Expo configuration", async () => {
    const [keyPem, appConfig] = await Promise.all([
      readFile(playgroundPath(".cordierite/key.pem"), "utf8"),
      readFile(playgroundPath("app.json"), "utf8"),
    ]);

    const cliPins = JSON.parse(appConfig).expo.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === "@cordierite/react-native",
    )[1].cliPins;

    expect(cliPins).toContain(getSpkiPinFromPrivateKeyPem(keyPem));
  });
});
