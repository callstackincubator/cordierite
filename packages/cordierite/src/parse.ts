import {
  tryParseConnectBootstrapWireString,
  validateConnectBootstrapPayload,
} from "cordierite-shared";

import { sessionError, validationError } from "./errors.js";

export const parseJsonObject = (value: string, fieldName: string): Record<string, unknown> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw validationError(`Invalid JSON provided for ${fieldName}.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw validationError(`${fieldName} must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
};

export const parseBootstrapPayload = (
  rawPayload: string,
  options: {
    requirePrivateIp?: boolean;
    nowUnixSeconds: number;
    allowExpired?: boolean;
  },
) => {
  const normalized = tryParseConnectBootstrapWireString(rawPayload);

  if (!normalized) {
    throw validationError(
      "Bootstrap payload must be base64url-encoded binary v1 (see docs/HANDSHAKE.md).",
      {
        require_private_ip: options.requirePrivateIp ?? false,
      },
    );
  }

  const isValid = validateConnectBootstrapPayload(normalized, {
    now: options.allowExpired ? undefined : options.nowUnixSeconds,
    requirePrivateIp: options.requirePrivateIp,
  });

  if (!isValid) {
    const validExceptTime = validateConnectBootstrapPayload(normalized, {
      requirePrivateIp: options.requirePrivateIp,
    });

    if (
      validExceptTime &&
      !options.allowExpired &&
      normalized.expiresAt <= options.nowUnixSeconds
    ) {
      throw sessionError("Bootstrap payload has expired.", {
        expires_at: normalized.expiresAt,
      });
    }

    throw validationError("Bootstrap payload is invalid.", {
      require_private_ip: options.requirePrivateIp ?? false,
    });
  }

  return normalized;
};
