import {
  decodeBootstrap,
  isExpiredAt,
  isLocalAddress,
  type BootstrapPayload,
} from "@cordierite/shared";

import {
  CordieriteBootstrapParseError,
  type CordieriteBootstrapConnectInput,
} from "./Cordierite.types";
import { logger } from "./logger";

export const parseBootstrapPayload = (
  rawPayload: string,
  options: {
    now?: number;
    requirePrivateIp?: boolean;
  } = {}
): BootstrapPayload => {
  const decoded = decodeBootstrap(rawPayload);

  if (!decoded) {
    logger.debug("parseBootstrapPayload: unparseable wire payload");
    throw new CordieriteBootstrapParseError(
      "invalid_payload",
      "Bootstrap payload must be a valid base64url-encoded v2 bootstrap blob (see Cordierite HANDSHAKE docs)."
    );
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);

  if (isExpiredAt(decoded.expiresAt, now)) {
    logger.debug("parseBootstrapPayload: expired");
    throw new CordieriteBootstrapParseError(
      "expired_payload",
      "Bootstrap payload has expired."
    );
  }

  if (options.requirePrivateIp && !isLocalAddress(decoded)) {
    logger.debug("parseBootstrapPayload: address is not local");
    throw new CordieriteBootstrapParseError(
      "invalid_payload",
      "Bootstrap payload is invalid."
    );
  }

  return decoded;
};

/** `sha256/` + 44 base64 chars (32-byte digest, standard alphabet incl. padding) — the exact shape
 * `createSpkiPin` (cordierite's `spki-pin.ts`) produces. Anything else is treated the same as an
 * absent `pin` param: a malformed/foreign value must never be handed to native as if it were a
 * real pin (native's own connect-time pin comparison would just fail it anyway, but there's no
 * reason to forward garbage). */
const LINK_PIN_PATTERN = /^sha256\/[A-Za-z0-9+/]{43}=$/u;

/** Extracts the bootstrap deep link's separate `pin` query param (opt-in hardening dev-mode —
 * distinct from, and never part of, the `cordierite` binary v2 payload decoded above). Returns
 * `undefined` for a missing or malformed value rather than throwing: an old/foreign link with no
 * `pin` param — or a link from some other future param scheme — must still bootstrap normally
 * via the `cordierite` payload alone. */
export const extractLinkPin = (url: URL): string | undefined => {
  const pin = url.searchParams.get("pin");

  if (pin === null || !LINK_PIN_PATTERN.test(pin)) {
    return undefined;
  }

  return pin;
};

export const parseBootstrapUrl = (
  rawUrl: string,
  options: {
    now?: number;
    requirePrivateIp?: boolean;
  } = {}
): CordieriteBootstrapConnectInput => {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    logger.debug("parseBootstrapUrl: invalid URL");
    throw new CordieriteBootstrapParseError(
      "invalid_url",
      "Invalid bootstrap URL."
    );
  }

  const payload = url.searchParams.get("cordierite");

  if (!payload) {
    logger.debug("parseBootstrapUrl: missing cordierite query param");
    throw new CordieriteBootstrapParseError(
      "missing_payload",
      "Bootstrap URL is missing the cordierite query parameter."
    );
  }

  const decoded = parseBootstrapPayload(payload, options);
  const linkPin = extractLinkPin(url);

  return linkPin === undefined ? decoded : { ...decoded, linkPin };
};
