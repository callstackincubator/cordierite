import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

export const createSpkiPin = (spkiDer: Buffer): string => {
  const digest = createHash("sha256").update(spkiDer).digest("base64");

  return `sha256/${digest}`;
};

export const getSpkiPinFromPrivateKeyPem = (keyPem: string): string => {
  const privateKey = createPrivateKey(keyPem);
  const publicKey = createPublicKey(privateKey);
  const spkiDer = Buffer.from(
    publicKey.export({
      type: "spki",
      format: "der",
    }),
  );

  return createSpkiPin(spkiDer);
};
