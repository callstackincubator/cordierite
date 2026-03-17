import { describe, expect, test } from "bun:test";

import { renderQrToTerminal } from "../qr-terminal.js";

describe("renderQrToTerminal", () => {
  test("produces half-block QR lines for a URL", () => {
    const out = renderQrToTerminal("https://example.com/bootstrap");
    expect(out).toContain("\n");
    expect(/[\u2580\u2584\u2588]/.test(out)).toBe(true);
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });
});
