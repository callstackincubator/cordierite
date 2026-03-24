import { describe, expect, test } from "bun:test";

import { createInteractiveHostReporter, createPlainTextHostReporter } from "../host-reporters.js";

const bootstrapUrl = "https://example.com/bootstrap";

describe("createInteractiveHostReporter", () => {
  test("writes carriage-return status lines and ends with newline on dispose", async () => {
    let out = "";
    const reporter = createInteractiveHostReporter({
      color: false,
      writer: {
        write(chunk) {
          out += chunk;
        },
      },
    });

    await reporter.onEvent({
      type: "host_started",
      host: {
        deep_link: bootstrapUrl,
        ttl_seconds: 30,
        spki_pin: "sha256/example",
        session_id: "session-123",
        wss_port: 8443,
        control_port: 41_000,
      },
    });
    reporter.onEvent({ type: "host_listening", session_id: "session-123" });
    expect(out.startsWith("\n")).toBe(true);
    expect(out).toContain("Device:");
    expect(out).toContain("waiting for connection");

    reporter.onEvent({ type: "session_claimed", session_id: "session-123" });
    expect(out.match(/\r\x1b\[K/g)?.length).toBe(2);
    expect(out).toContain("connected");
    expect(out.endsWith("connected")).toBe(true);

    reporter.onEvent({ type: "session_disconnected", session_id: "session-123" });
    expect(out.match(/\r\x1b\[K/g)?.length).toBe(3);
    expect(out).toContain("disconnected");

    reporter.dispose();
    expect(out.endsWith("\n")).toBe(true);
  });

  test("onClaimed appends device metadata when provided", async () => {
    let out = "";
    const reporter = createInteractiveHostReporter({
      color: false,
      writer: {
        write(chunk) {
          out += chunk;
        },
      },
    });

    await reporter.onEvent({
      type: "host_started",
      host: {
        deep_link: bootstrapUrl,
        ttl_seconds: 30,
        spki_pin: "sha256/example",
        session_id: "session-123",
        wss_port: 8443,
        control_port: 41_000,
      },
    });
    reporter.onEvent({ type: "host_listening", session_id: "session-123" });
    reporter.onEvent({
      type: "session_claimed",
      session_id: "session-123",
      device: {
        manufacturer: "Apple",
        model: "iPhone15,2",
        os: "iOS 18.2",
      },
    });

    expect(out).toContain("connected");
    expect(out).toContain("Apple");
    expect(out).toContain("iPhone15,2");
    expect(out).toContain("iOS 18.2");
    expect(out.endsWith("iOS 18.2")).toBe(true);
  });

  test("dispose without prior updates writes nothing", () => {
    let out = "";
    const reporter = createInteractiveHostReporter({
      color: false,
      writer: {
        write(chunk) {
          out += chunk;
        },
      },
    });

    reporter.dispose();
    expect(out).toBe("");
  });

  test("second dispose is idempotent", async () => {
    let out = "";
    const reporter = createInteractiveHostReporter({
      color: false,
      writer: {
        write(chunk) {
          out += chunk;
        },
      },
    });

    await reporter.onEvent({
      type: "host_started",
      host: {
        deep_link: bootstrapUrl,
        ttl_seconds: 30,
        spki_pin: "sha256/example",
        session_id: "session-123",
        wss_port: 8443,
        control_port: 41_000,
      },
    });
    reporter.onEvent({ type: "host_listening", session_id: "session-123" });
    reporter.dispose();
    const afterFirst = out.length;
    reporter.dispose();
    expect(out.length).toBe(afterFirst);
  });

  test("onListening before QR completes still yields QR before device line", async () => {
    let out = "";
    const reporter = createInteractiveHostReporter({
      color: false,
      writer: {
        write(chunk) {
          out += chunk;
        },
      },
    });

    reporter.onEvent({ type: "host_listening", session_id: "session-123" });
    await reporter.onEvent({
      type: "host_started",
      host: {
        deep_link: bootstrapUrl,
        ttl_seconds: 30,
        spki_pin: "sha256/example",
        session_id: "session-123",
        wss_port: 8443,
        control_port: 41_000,
      },
    });

    const deviceIdx = out.indexOf("Device:");
    expect(deviceIdx).toBeGreaterThan(0);
    expect(/\x1b\[|\u2588|\u2584|\u2580/.test(out.slice(0, deviceIdx))).toBe(true);
    expect(out).toContain(bootstrapUrl);
    expect(out).toContain("waiting for connection");
  });

  test("onClaimed before QR completes still yields QR before device line", async () => {
    let out = "";
    const reporter = createInteractiveHostReporter({
      color: false,
      writer: {
        write(chunk) {
          out += chunk;
        },
      },
    });

    reporter.onEvent({ type: "host_listening", session_id: "session-123" });
    reporter.onEvent({
      type: "session_claimed",
      session_id: "session-123",
      device: {
        manufacturer: "Apple",
        model: "iPhone",
        os: "iOS 18",
      },
    });
    await reporter.onEvent({
      type: "host_started",
      host: {
        deep_link: bootstrapUrl,
        ttl_seconds: 30,
        spki_pin: "sha256/example",
        session_id: "session-123",
        wss_port: 8443,
        control_port: 41_000,
      },
    });

    const deviceIdx = out.indexOf("Device:");
    expect(deviceIdx).toBeGreaterThan(0);
    expect(/\x1b\[|\u2588|\u2584|\u2580/.test(out.slice(0, deviceIdx))).toBe(true);
    expect(out).toContain(bootstrapUrl);
    expect(out).toContain("connected");
    expect(out).toContain("Apple");
  });

  test("prints QR before device line when QR completes first", async () => {
    let out = "";
    const reporter = createInteractiveHostReporter({
      color: false,
      writer: {
        write(chunk) {
          out += chunk;
        },
      },
    });

    await reporter.onEvent({
      type: "host_started",
      host: {
        deep_link: bootstrapUrl,
        ttl_seconds: 30,
        spki_pin: "sha256/example",
        session_id: "session-123",
        wss_port: 8443,
        control_port: 41_000,
      },
    });
    reporter.onEvent({ type: "host_listening", session_id: "session-123" });

    const deviceIdx = out.indexOf("Device:");
    expect(deviceIdx).toBeGreaterThan(0);
    expect(/\x1b\[|\u2588|\u2584|\u2580/.test(out.slice(0, deviceIdx))).toBe(true);
    expect(out).toContain(bootstrapUrl);
    expect(out).toContain("waiting for connection");
  });
});

describe("createPlainTextHostReporter", () => {
  test("prints simple line-oriented updates without ANSI cursor control", () => {
    let out = "";
    const reporter = createPlainTextHostReporter({
      color: false,
      writer: {
        write(chunk) {
          out += chunk;
        },
      },
    });

    reporter.onEvent({
      type: "host_started",
      host: {
        deep_link: bootstrapUrl,
        ttl_seconds: 30,
        spki_pin: "sha256/example",
        session_id: "session-123",
        wss_port: 8443,
        control_port: 41_000,
      },
    });
    reporter.onEvent({ type: "host_listening", session_id: "session-123" });
    reporter.onEvent({
      type: "session_claimed",
      session_id: "session-123",
      device: {
        manufacturer: "Apple",
        model: "iPhone15,2",
        os: "iOS 18.2",
      },
    });
    reporter.onEvent({ type: "session_disconnected", session_id: "session-123" });

    expect(out).toContain("Deep link:");
    expect(out).toContain("Device: waiting for connection");
    expect(out).toContain("Device: connected (Apple · iPhone15,2 · iOS 18.2)");
    expect(out).toContain("Device: disconnected");
    expect(out).not.toContain("\x1b[");
  });
});
