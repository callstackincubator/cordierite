import type { HostCommandOptions } from "../commands/host.js";
import { usageError } from "../errors.js";

export const toHostCommandOptions = (parsed: Record<string, unknown>): HostCommandOptions => {
  const tlsCert = parsed.tlsCert;
  const tlsKey = parsed.tlsKey;
  const ip = parsed.ip;
  const port = parsed.port;
  const ttlSeconds = parsed.ttl;
  const scheme = parsed.scheme;

  return {
    tlsCert: typeof tlsCert === "string" ? tlsCert : "",
    tlsKey: typeof tlsKey === "string" ? tlsKey : "",
    ip: typeof ip === "string" ? ip : undefined,
    port: typeof port === "number" ? port : Number(port),
    ttlSeconds:
      typeof ttlSeconds === "number"
        ? ttlSeconds
        : ttlSeconds === undefined
          ? undefined
          : Number(ttlSeconds),
    scheme: typeof scheme === "string" ? scheme : "",
    open: Boolean(parsed.open),
  };
};

export const requireConnectPayload = (parsed: Record<string, unknown>): string => {
  const payload = parsed.payload;

  if (typeof payload !== "string" || payload.length === 0) {
    throw usageError("The connect command requires --payload.");
  }

  return payload;
};

export const requireToolName = (parsedArgs: ReadonlyArray<string>): string => {
  const name = parsedArgs[0];

  if (typeof name !== "string" || name.length === 0) {
    throw usageError("The invoke command requires a tool name.");
  }

  return name;
};

export const requireSessionId = (parsed: Record<string, unknown>): string => {
  const raw = parsed.sessionId;

  if (raw === undefined || raw === null) {
    throw usageError("The command requires --session-id (opaque id from `cordierite host` JSON output).");
  }

  const id = typeof raw === "number" && Number.isFinite(raw) ? String(Math.trunc(raw)) : String(raw).trim();

  if (id.length === 0) {
    throw usageError("The --session-id must be non-empty.");
  }

  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(id)) {
    throw usageError(
      "The --session-id must be the opaque session id from the host (base64url-style: letters, digits, _ or -).",
    );
  }

  return id;
};
