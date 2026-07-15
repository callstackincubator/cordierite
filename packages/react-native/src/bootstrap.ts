import {
  decodeBootstrap,
  isExpiredAt,
  isLocalAddress,
  type BootstrapPayload,
} from "@cordierite/shared";

import { CordieriteBootstrapParseError } from "./Cordierite.types";
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

export const parseBootstrapUrl = (
  rawUrl: string,
  options: {
    now?: number;
    requirePrivateIp?: boolean;
  } = {}
): BootstrapPayload => {
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

  return parseBootstrapPayload(payload, options);
};
