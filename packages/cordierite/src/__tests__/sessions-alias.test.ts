/**
 * Unit tests for alias slugging (ARCHITECTURE.md §5: "slugified device_model ... deduplicated
 * with -2, -3 suffixes. Fallback slug: device."). The full claim/resume/registry lifecycle is
 * exercised end-to-end in session-engine.integration.test.ts; these are the pure-function edge
 * cases that would be awkward to hit reliably over a real socket.
 */

import { describe, expect, test } from "vitest";

import { dedupeAlias, slugifyDeviceModel } from "../daemon/sessions.js";

describe("slugifyDeviceModel", () => {
  test("lowercases and replaces non-alphanumeric runs with a single dash", () => {
    expect(slugifyDeviceModel("Pixel 8 Pro")).toBe("pixel-8-pro");
    expect(slugifyDeviceModel("iPhone_15,Pro Max")).toBe("iphone-15-pro-max");
  });

  test("strips leading/trailing dashes produced by punctuation at the edges", () => {
    expect(slugifyDeviceModel("!!Galaxy S24!!")).toBe("galaxy-s24");
  });

  test("falls back to \"device\" when the model is missing, empty, or all-punctuation", () => {
    expect(slugifyDeviceModel(undefined)).toBe("device");
    expect(slugifyDeviceModel("")).toBe("device");
    expect(slugifyDeviceModel("!!!")).toBe("device");
  });
});

describe("dedupeAlias", () => {
  test("returns the base alias when it is not already taken", () => {
    expect(dedupeAlias("pixel-8", new Set())).toBe("pixel-8");
  });

  test("appends -2 on the first collision", () => {
    expect(dedupeAlias("pixel-8", new Set(["pixel-8"]))).toBe("pixel-8-2");
  });

  test("keeps incrementing past -2 for repeated collisions", () => {
    expect(dedupeAlias("pixel-8", new Set(["pixel-8", "pixel-8-2", "pixel-8-3"]))).toBe("pixel-8-4");
  });
});
