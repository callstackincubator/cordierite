import { describe, expect, test } from "bun:test";

import { createHostDeviceStatusReporter } from "../host-device-status.js";

const bootstrapUrl = "https://example.com/bootstrap";

describe("createHostDeviceStatusReporter", () => {
  test("writes carriage-return status lines and ends with newline on dispose", async () => {
    let out = "";
    const reporter = createHostDeviceStatusReporter({
      color: false,
      write(chunk) {
        out += chunk;
      },
    });

    await reporter.printBootstrapQr(bootstrapUrl, 30);
    reporter.onListening();
    expect(out.startsWith("\n")).toBe(true);
    expect(out).toContain("Device:");
    expect(out).toContain("waiting for connection");
    expect(out).toContain("TTL:");
    expect(out).toContain("30s");

    reporter.onClaimed();
    expect(out.match(/\r\x1b\[K/g)?.length).toBe(2);
    expect(out).toContain("connected");
    expect(out.endsWith("connected")).toBe(true);

    reporter.onClaimedSessionEnded();
    expect(out.match(/\r\x1b\[K/g)?.length).toBe(3);
    expect(out).toContain("disconnected");

    reporter.dispose();
    expect(out.endsWith("\n")).toBe(true);
  });

  test("onClaimed appends device metadata when provided", async () => {
    let out = "";
    const reporter = createHostDeviceStatusReporter({
      color: false,
      write(chunk) {
        out += chunk;
      },
    });

    await reporter.printBootstrapQr(bootstrapUrl, 30);
    reporter.onListening();
    reporter.onClaimed({
      manufacturer: "Apple",
      model: "iPhone15,2",
      os: "iOS 18.2",
    });

    expect(out).toContain("connected");
    expect(out).toContain("Apple");
    expect(out).toContain("iPhone15,2");
    expect(out).toContain("iOS 18.2");
    expect(out.endsWith("iOS 18.2")).toBe(true);
  });

  test("dispose without prior updates writes nothing", () => {
    let out = "";
    const reporter = createHostDeviceStatusReporter({
      color: false,
      write(chunk) {
        out += chunk;
      },
    });

    reporter.dispose();
    expect(out).toBe("");
  });

  test("second dispose is idempotent", async () => {
    let out = "";
    const reporter = createHostDeviceStatusReporter({
      color: false,
      write(chunk) {
        out += chunk;
      },
    });

    await reporter.printBootstrapQr(bootstrapUrl, 30);
    reporter.onListening();
    reporter.dispose();
    const afterFirst = out.length;
    reporter.dispose();
    expect(out.length).toBe(afterFirst);
  });

  test("onListening before QR completes still yields QR before device line", async () => {
    let out = "";
    const reporter = createHostDeviceStatusReporter({
      color: false,
      write(chunk) {
        out += chunk;
      },
    });

    const qrPromise = reporter.printBootstrapQr(bootstrapUrl, 30);
    reporter.onListening();
    await qrPromise;

    const deviceIdx = out.indexOf("Device:");
    expect(deviceIdx).toBeGreaterThan(0);
    expect(/\x1b\[|\u2588|\u2584|\u2580/.test(out.slice(0, deviceIdx))).toBe(true);
    expect(out).toContain(bootstrapUrl);
    expect(out).toContain("waiting for connection");
    expect(out).toContain("TTL:");
  });

  test("onClaimed before QR completes still yields QR before device line", async () => {
    let out = "";
    const reporter = createHostDeviceStatusReporter({
      color: false,
      write(chunk) {
        out += chunk;
      },
    });

    reporter.onListening();
    reporter.onClaimed({
      manufacturer: "Apple",
      model: "iPhone",
      os: "iOS 18",
    });
    await reporter.printBootstrapQr(bootstrapUrl, 30);

    const deviceIdx = out.indexOf("Device:");
    expect(deviceIdx).toBeGreaterThan(0);
    expect(/\x1b\[|\u2588|\u2584|\u2580/.test(out.slice(0, deviceIdx))).toBe(true);
    expect(out).toContain(bootstrapUrl);
    expect(out).toContain("connected");
    expect(out).toContain("Apple");
    expect(out).not.toContain("TTL:");
  });

  test("prints QR before device line when QR completes first", async () => {
    let out = "";
    const reporter = createHostDeviceStatusReporter({
      color: false,
      write(chunk) {
        out += chunk;
      },
    });

    await reporter.printBootstrapQr(bootstrapUrl, 30);
    reporter.onListening();

    const deviceIdx = out.indexOf("Device:");
    expect(deviceIdx).toBeGreaterThan(0);
    expect(/\x1b\[|\u2588|\u2584|\u2580/.test(out.slice(0, deviceIdx))).toBe(true);
    expect(out).toContain(bootstrapUrl);
    expect(out).toContain("waiting for connection");
    expect(out).toContain("TTL:");
  });
});
