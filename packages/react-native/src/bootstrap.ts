import {
  tryParseConnectBootstrapWireString,
  validateConnectBootstrapPayload,
  type ConnectBootstrapPayload,
} from "@cordierite/shared";

import { CordieriteBootstrapParseError } from "./Cordierite.types";
import { logger } from "./logger";

export const parseBootstrapPayload = (
  rawPayload: string,
  options: {
    now?: number;
    requirePrivateIp?: boolean;
  } = {}
): ConnectBootstrapPayload => {
  const normalized = tryParseConnectBootstrapWireString(rawPayload);

  if (!normalized) {
    logger.debug("parseBootstrapPayload: unparseable wire string");
    throw new CordieriteBootstrapParseError(
      "invalid_payload",
      "Bootstrap payload must be base64url-encoded binary v1 (see Cordierite HANDSHAKE docs)."
    );
  }

  const isValid = validateConnectBootstrapPayload(normalized, {
    now: options.now,
    requirePrivateIp: options.requirePrivateIp,
  });

  if (isValid) {
    return normalized;
  }

  const validExceptTime = validateConnectBootstrapPayload(normalized, {
    requirePrivateIp: options.requirePrivateIp,
  });

  if (
    options.now !== undefined &&
    validExceptTime &&
    normalized.expiresAt <= options.now
  ) {
    logger.debug("parseBootstrapPayload: expired");
    throw new CordieriteBootstrapParseError(
      "expired_payload",
      "Bootstrap payload has expired."
    );
  }

  logger.debug("parseBootstrapPayload: validation failed");
  throw new CordieriteBootstrapParseError(
    "invalid_payload",
    "Bootstrap payload is invalid."
  );
};

export const parseBootstrapUrl = (
  rawUrl: string,
  options: {
    now?: number;
    requirePrivateIp?: boolean;
  } = {}
): ConnectBootstrapPayload => {
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
