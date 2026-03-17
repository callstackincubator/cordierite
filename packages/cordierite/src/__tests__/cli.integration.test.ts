import { createServer } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import {
  binEntry,
  createPayload,
  FIXED_NOW,
  packageRoot,
  runCliWithCapture,
} from "./fixtures.js";

const SAMPLE_HOST_CERT = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUJQNMDmx0oMrw6m3y32VPygeoH+EwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPY29yZGllcml0ZS10ZXN0MB4XDTI2MDMyMzA3MjMzNFoX
DTM2MDMyMDA3MjMzNFowGjEYMBYGA1UEAwwPY29yZGllcml0ZS10ZXN0MIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs9SQeBc/IMmV+/2FE6xvdFAMGsSX
orZsB3E5mXv3quuF7S7cJ1Bf5EzWgzgVsevpjsQz5VQfuXOT0TXcmrEuCSuiO8Bt
BHqsLhag9laNKfsMMUu+Cr9SeGYWgqGauT6cMIH6/siyOEEWiEbNY+/Gc08YmvNR
MNqqa67c5WxONO0XH2NW1DjrKAU9ITruBQo1R3+0escUO9ayzjgkzf6NR4LEOPSg
sm12psJHrt0Uz+TuKH48/GA/LWTf7nqmyqv/1c84ivkgLBukldLG+laoaJwO8kKp
/Vhocl+oZy163dxu+vzravyVf3w7e7Qnz4binQ9HHzgS3FHZBK3mfhhlWwIDAQAB
o1MwUTAdBgNVHQ4EFgQU4Gxp419NKfrUlkCrWyW9oXseykowHwYDVR0jBBgwFoAU
4Gxp419NKfrUlkCrWyW9oXseykowDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEANNAWvdTXHGLeelSNVj7gP5i+0jdRCKQ5eUMEHHwl5U5TqGjqLttK
9HR9hZmgxQJSvJACUBnZ4UDomCLobZrFlAvVBQvWgu75xtuPB+c739hnXQaXybkv
G8GzeL2JGhX9/Nuu+w5wYYTowqtqa96nG5cG2lWy1yRpVXYYNJ7v700N4MScuQqk
ww8CDd4Ops6ytaQ9NtJjVswxUpsmUxJePuHCLd+hRt16bdW+dn+lXhovXXGcjsXx
sHCpx7My0ZOKmh3CuESIeWc8kE1RFRp9HLRpuV7nOWojLzClad5aKeZvAQwI8l1q
0N28icz5qYWGVYL/c0JLtEXX66PSqRJWMA==
-----END CERTIFICATE-----`;

const SAMPLE_HOST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCz1JB4Fz8gyZX7
/YUTrG90UAwaxJeitmwHcTmZe/eq64XtLtwnUF/kTNaDOBWx6+mOxDPlVB+5c5PR
NdyasS4JK6I7wG0EeqwuFqD2Vo0p+wwxS74Kv1J4ZhaCoZq5Ppwwgfr+yLI4QRaI
Rs1j78ZzTxia81Ew2qprrtzlbE407RcfY1bUOOsoBT0hOu4FCjVHf7R6xxQ71rLO
OCTN/o1HgsQ49KCybXamwkeu3RTP5O4ofjz8YD8tZN/ueqbKq//VzziK+SAsG6SV
0sb6VqhonA7yQqn9WGhyX6hnLXrd3G76/Otq/JV/fDt7tCfPhuKdD0cfOBLcUdkE
reZ+GGVbAgMBAAECggEAKDmWfT5Z8RgWdBDv6QgrwB09r+kksBFVFc8WXsYzjqhz
Qyw1s5ePc45ad2yesbc+/Z/WqegI1p9LQ8NkDrguP3/ioLH40MUt6XtHUwLmPas5
vXcfUeEc7fCL/XlvlhsyrckNX1t+PgYVJ7OKst2KCvX434Qot6BZ+Y9aOvlgfwbf
lg7A9fixWcCo4gIpwksVGfnYVmbtlVEyqVCltRTf/FQJHPthqXVX4Ji8LLVZczqp
5945rrNmB8RUL8HQHNmdHa1+T6AjyUeNUzw5Tea/MP3P5wQecAH+KlAeNEAv5P0q
/c/fRlNPXvZkwS/qJq8QbEwUg9fu/v8r2mNskoFwOQKBgQDeUpWPDXXqFTTXSMy+
gh3npwOGs3Cfsz3L4awTznqdOvA9NG3fh5vM4L5WIIzTfFbtE2mChftC/ZNOYwdG
cw5cBJr3Sb856Hpl42OgxuN8gPNiVDGWkLuzaAc8J6GtLn3akyglKQlOnlSBqBY4
1T6jvdeTQcmZW9iNtQgbgFrbCQKBgQDPEi2/l02aX8PScgRzYec0soRCPbcdFTs0
S0C0P2lOKa7WCa2XBd31xhwHdt5v0gms5qls9DJzn2SHpoBB9CImfQNA8nW2SSjl
cmnmn9wbA5LUb680cdou1NDtMGzLk+GobWd9Lg7xlceoXvFx3JmWNQxur7JWxN1y
k2iEA4MCQwKBgHHzlFLBTHnRqsbZuo++84MDuKv3FzfT0E3K+r8gKvqh9fb5A4P5
5uJpI0XT4zqW1ZsoQwEymSmp/THFUjpKyMZjWeZ79zbAMNQ+a5dBueHb2mPA0bXh
s0Nug57SlWzFkp5QpNf/I5UXVCsss08oBbY5nOAObT1ctS9U5bXq4Sa5AoGBAJQa
cnIoK68Qc6TfO+Oy0IVWcVZXgdLhTpkWgc7p08297njULz5nSdvxuDZ2hJ4B4j2y
NNfiyPr9tA95vR5vGMXigCNBx4N7TC7f6HK1P95qbehXgT7Hd8ArIsui6Q2qVan7
phtYiAOul0ELtzEzEP7oLl40eB+rap/6YrSZNmi1AoGAYAl3AKZDxJb99RMw3OBS
7kCLK1a8K2Ta5lZBIBPzOSk6n2+gTi1WfpesMBbtQQxgRGNs5V7qUWaATwbboM2Z
lagOL4n/IA1cPyxGJgPIWSJ25n2Dukdlnvga0Z+MRlZqZYkq6YMF70+BC/oGfzyN
9U6JED+irLNvKFOJ6MGF6rc=
-----END PRIVATE KEY-----`;

const createHostTlsFiles = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cordierite-host-test-"));
  const certPath = path.join(directory, "cert.pem");
  const keyPath = path.join(directory, "key.pem");

  await Promise.all([
    writeFile(certPath, SAMPLE_HOST_CERT, "utf8"),
    writeFile(keyPath, SAMPLE_HOST_KEY, "utf8"),
  ]);

  return {
    directory,
    certPath,
    keyPath,
  };
};

const getAvailablePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  if (!address || typeof address === "string") {
    throw new Error("Expected test server to listen on a TCP port.");
  }

  return address.port;
};

describe("CLI integration", () => {
  let previousSessionsDir: string | undefined;
  let testSessionsDir: string;

  beforeAll(async () => {
    previousSessionsDir = process.env.CORDIERITE_SESSIONS_DIR;
    testSessionsDir = path.join(tmpdir(), `cordierite-cli-test-${randomUUID()}`);
    process.env.CORDIERITE_SESSIONS_DIR = testSessionsDir;
    await mkdir(testSessionsDir, { recursive: true });
  });

  afterAll(() => {
    if (previousSessionsDir === undefined) {
      delete process.env.CORDIERITE_SESSIONS_DIR;
    } else {
      process.env.CORDIERITE_SESSIONS_DIR = previousSessionsDir;
    }
  });

  afterEach(async () => {
    await rm(testSessionsDir, { force: true, recursive: true });
    await mkdir(testSessionsDir, { recursive: true });
  });

  test("tools --json emits a single structured JSON object", async () => {
    const result = await runCliWithCapture(["tools", "--json", "--session-id", "NoSuchSessionTool01"]);

    expect(result.exitCode).toBe(70);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.type).toBe("connection_error");
  });

  test("connect rejects expired payloads with a typed error", async () => {
    const result = await runCliWithCapture([
      "connect",
      "--json",
      "--payload",
      createPayload({
        expiresAt: Math.floor(FIXED_NOW.getTime() / 1000) - 1,
      }),
    ]);

    expect(result.exitCode).toBe(71);

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: false,
      error: {
        type: "session_error",
      },
    });
  });

  test("connect rejects malformed payloads with a validation error", async () => {
    const result = await runCliWithCapture(["connect", "--json", "--payload", "not-json"]);

    expect(result.exitCode).toBe(65);

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: false,
      error: {
        type: "validation_error",
      },
    });
  });

  test("invoke fails cleanly when no active host exists", async () => {
    const result = await runCliWithCapture(["invoke", "app.echo", "--json", "--session-id", "NoSuchSessionInvk01"]);

    expect(result.exitCode).toBe(70);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.type).toBe("connection_error");
  });

  test("session lists registry entries and resolves selected with --session-id", async () => {
    const opaqueSessionId = "IntegrationTestSess01";

    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/session") {
        response.writeHead(200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            ok: true,
            data: {
              status: "active",
              session_id: opaqueSessionId,
              endpoint: {
                ip: "192.168.1.42",
                port: 8443,
                url: "wss://192.168.1.42:8443",
              },
            },
          }),
        );
        return;
      }

      response.writeHead(404, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ ok: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected test server to listen on a TCP port.");
    }

    await writeFile(
      path.join(testSessionsDir, `${opaqueSessionId}.json`),
      `${JSON.stringify({
        sessionId: opaqueSessionId,
        controlPort: address.port,
        wssPort: 8443,
        ip: "192.168.1.42",
        pid: process.pid,
        registeredAt: FIXED_NOW.toISOString(),
        lastSeenAt: FIXED_NOW.toISOString(),
        status: "active",
        endpoint: {
          ip: "192.168.1.42",
          port: 8443,
          url: "wss://192.168.1.42:8443",
        },
        remoteTools: [],
      })}\n`,
      "utf8",
    );

    const result = await runCliWithCapture(["session", "--json", "--session-id", opaqueSessionId]);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.sessions).toHaveLength(1);
    expect(parsed.data.sessions[0]).toMatchObject({
      session_id: opaqueSessionId,
      status: "active",
      wss_port: 8443,
      tool_count: 0,
      endpoint: {
        url: "wss://192.168.1.42:8443",
      },
    });
    expect(typeof parsed.data.sessions[0].control_port).toBe("number");
    expect(parsed.data.selected).toMatchObject({
      status: "active",
      session_id: opaqueSessionId,
      wss_port: 8443,
      tool_count: 0,
      endpoint: {
        url: "wss://192.168.1.42:8443",
      },
    });
    expect(typeof parsed.data.selected.control_port).toBe("number");
  });

  test("human mode supports no-color output", async () => {
    const result = await runCliWithCapture(["tools", "--session-id", "NoSuchSessionHuman1", "--no-color"]);

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("Command Failed");
    expect(result.stderr).not.toContain("\u001b[");
  });

  test("host requires --scheme", async () => {
    const result = await runCliWithCapture([
      "host",
      "--tls-cert",
      "x",
      "--tls-key",
      "y",
      "--json",
    ]);

    expect(result.exitCode).toBe(64);

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: false,
      error: {
        type: "usage_error",
        message: "The host command requires --scheme.",
      },
    });
  });

  test("host --json emits minimal bootstrap data and exits when ttl expires", async () => {
    const tlsFiles = await createHostTlsFiles();
    const port = await getAvailablePort();

    try {
      const result = await runCliWithCapture([
        "host",
        "--tls-cert",
        tlsFiles.certPath,
        "--tls-key",
        tlsFiles.keyPath,
        "--scheme",
        "playground",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--ttl",
        "1",
        "--json",
      ]);

      expect(result.exitCode).toBe(71);
      expect(result.stderr).toBe("Pending session TTL expired before any app connected.\n");

      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.meta.command).toBe("host");
      expect(parsed.data.host.deep_link).toContain("playground:///?cordierite=");
      expect(parsed.data.host.spki_pin).toMatch(/^sha256\//u);
      expect(parsed.data.host.ttl_seconds).toBe(1);
      expect(parsed.data.host.session_id).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
      expect(parsed.data.host.wss_port).toBe(port);
      expect(typeof parsed.data.host.control_port).toBe("number");
      expect(Object.keys(parsed.data.host).sort()).toEqual([
        "control_port",
        "deep_link",
        "session_id",
        "spki_pin",
        "ttl_seconds",
        "wss_port",
      ]);
    } finally {
      await rm(tlsFiles.directory, { force: true, recursive: true });
    }
  });

  test("help is available from the binary entrypoint", () => {
    const command = Bun.spawnSync({
      cmd: ["bun", binEntry, "--help"],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(command.exitCode).toBe(0);
  });

  test("version is available from the binary entrypoint", () => {
    const command = Bun.spawnSync({
      cmd: ["bun", binEntry, "--version"],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(command.exitCode).toBe(0);
  });
});
