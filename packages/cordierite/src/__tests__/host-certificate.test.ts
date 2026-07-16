import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "vitest";
import { X509Certificate } from "node:crypto";

import { generateHostCertificate } from "../host-certificate.js";

const createPrivateKeyPem = (type: "ec" | "rsa" = "ec"): string => {
  const pair =
    type === "rsa"
      ? generateKeyPairSync("rsa", {
          modulusLength: 2048,
        })
      : generateKeyPairSync("ec", {
          namedCurve: "P-256",
        });

  return pair.privateKey
    .export({
      format: "pem",
      type: "pkcs8",
    })
    .toString("utf8");
};

describe("generateHostCertificate", () => {
  test("includes loopback SANs", async () => {
    const generated = await generateHostCertificate(createPrivateKeyPem(), "127.0.0.1");
    const certificate = new X509Certificate(generated.certPem);

    expect(certificate.subjectAltName).toContain("DNS:localhost");
    expect(certificate.subjectAltName).toContain("IP Address:127.0.0.1");
  });

  test("includes the explicit advertised LAN IP", async () => {
    const generated = await generateHostCertificate(createPrivateKeyPem(), "192.168.1.42");
    const certificate = new X509Certificate(generated.certPem);

    expect(certificate.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(certificate.subjectAltName).toContain("IP Address:192.168.1.42");
  });

  test("keeps the SPKI pin stable for the same key", async () => {
    const keyPem = createPrivateKeyPem("rsa");
    const first = await generateHostCertificate(keyPem, "127.0.0.1");
    const second = await generateHostCertificate(keyPem, "192.168.1.42");

    expect(first.spkiPin).toBe(second.spkiPin);
  });
});
