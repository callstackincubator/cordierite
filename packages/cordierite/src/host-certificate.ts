import "reflect-metadata";

import {
  createPrivateKey,
  createPublicKey,
  type JsonWebKey,
  randomBytes,
  webcrypto,
} from "node:crypto";

import {
  BasicConstraintsExtension,
  DNS,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  IP,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";

import { getSpkiPinFromPrivateKeyPem } from "./spki-pin.js";

type GeneratedHostCertificate = {
  certPem: string;
  spkiPin: string;
};

type ImportedKeyPair = {
  keyType: "rsa" | "ec";
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  signingAlgorithm: Algorithm | EcdsaParams;
};

const CERT_VALIDITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CERT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const toArrayBuffer = (view: Buffer): ArrayBuffer => {
  return Uint8Array.from(view).buffer;
};

const decodeBase64Url = (value: string): Uint8Array => {
  return Uint8Array.from(Buffer.from(value, "base64url"));
};

const resolveEcHash = (curve: string): AlgorithmIdentifier => {
  switch (curve) {
    case "P-256":
      return "SHA-256";
    case "P-384":
      return "SHA-384";
    case "P-521":
      return "SHA-512";
    default:
      throw new Error(`Unsupported EC named curve "${curve}" for Cordierite host certificates.`);
  }
};

const importSigningKeyPair = async (keyPem: string): Promise<ImportedKeyPair> => {
  const privateKeyObject = createPrivateKey(keyPem);
  const publicKeyObject = createPublicKey(privateKeyObject);
  const privateKeyDer = Buffer.from(privateKeyObject.export({ format: "der", type: "pkcs8" }));
  const publicKeyDer = Buffer.from(publicKeyObject.export({ format: "der", type: "spki" }));
  const jwk = privateKeyObject.export({ format: "jwk" }) as JsonWebKey;

  if (jwk.kty === "RSA") {
    const modulusLength = privateKeyObject.asymmetricKeyDetails?.modulusLength;

    if (typeof modulusLength !== "number" || typeof jwk.e !== "string") {
      throw new Error("Cordierite could not determine RSA key details for certificate generation.");
    }

    const publicExponent = decodeBase64Url(jwk.e) as Uint8Array<ArrayBuffer>;
    const importAlgorithm = {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength,
      publicExponent,
    } satisfies RsaHashedImportParams & RsaHashedKeyGenParams;

    return {
      keyType: "rsa",
      privateKey: await webcrypto.subtle.importKey(
        "pkcs8",
        toArrayBuffer(privateKeyDer),
        importAlgorithm,
        false,
        ["sign"],
      ),
      publicKey: await webcrypto.subtle.importKey(
        "spki",
        toArrayBuffer(publicKeyDer),
        importAlgorithm,
        true,
        ["verify"],
      ),
      signingAlgorithm: {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
    };
  }

  if (jwk.kty === "EC") {
    const namedCurve = jwk.crv;

    if (typeof namedCurve !== "string") {
      throw new Error("Cordierite could not determine the EC named curve for certificate generation.");
    }

    const importAlgorithm = {
      name: "ECDSA",
      namedCurve,
    } satisfies EcKeyImportParams;
    const signingAlgorithm = {
      ...importAlgorithm,
      hash: resolveEcHash(namedCurve),
    } satisfies EcKeyImportParams & EcdsaParams;

    return {
      keyType: "ec",
      privateKey: await webcrypto.subtle.importKey(
        "pkcs8",
        toArrayBuffer(privateKeyDer),
        importAlgorithm,
        false,
        ["sign"],
      ),
      publicKey: await webcrypto.subtle.importKey(
        "spki",
        toArrayBuffer(publicKeyDer),
        importAlgorithm,
        true,
        ["verify"],
      ),
      signingAlgorithm: {
        name: "ECDSA",
        hash: resolveEcHash(namedCurve),
      },
    };
  }

  throw new Error(`Cordierite does not support "${jwk.kty ?? privateKeyObject.asymmetricKeyType}" host keys.`);
};

export const generateHostCertificate = async (
  keyPem: string,
  advertisedIp: string,
): Promise<GeneratedHostCertificate> => {
  const keys = await importSigningKeyPair(keyPem);
  const sanEntries: Array<{ type: typeof DNS | typeof IP; value: string }> = [
    { type: DNS, value: "localhost" },
    { type: IP, value: "127.0.0.1" },
  ];

  if (advertisedIp !== "127.0.0.1") {
    sanEntries.push({ type: IP, value: advertisedIp });
  }

  const keyUsage =
    KeyUsageFlags.digitalSignature |
    (keys.keyType === "rsa" ? KeyUsageFlags.keyEncipherment : KeyUsageFlags.keyAgreement);

  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      name: "CN=Cordierite Host",
      notBefore: new Date(Date.now() - CERT_CLOCK_SKEW_MS),
      notAfter: new Date(Date.now() + CERT_VALIDITY_WINDOW_MS),
      signingAlgorithm: keys.signingAlgorithm,
      keys: {
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
      },
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(keyUsage, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], false),
        new SubjectAlternativeNameExtension(sanEntries, false),
        await SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    },
  );

  const certPem = certificate.toString("pem");

  return {
    certPem,
    spkiPin: getSpkiPinFromPrivateKeyPem(keyPem),
  };
};
