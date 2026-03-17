import type { SessionId, SessionToken } from "./session.js";
import type { ToolDescriptor } from "./cli.js";

/** Max length per optional `session_claim` device field (UTF-16 code units on the wire as JSON strings). */
export const SESSION_CLAIM_DEVICE_FIELD_MAX_LENGTH = 256;

export type SessionClaimDeviceInfo = {
  manufacturer?: string;
  model?: string;
  os?: string;
};

export type SessionBoundMessage = {
  type: string;
  session_id: SessionId;
};

export type SessionClaimMessage = {
  type: "session_claim";
  session_id: SessionId;
  token: SessionToken;
  device_manufacturer?: string;
  device_model?: string;
  device_os?: string;
};

export type SessionAckMessage = {
  type: "session_ack";
  session_id: SessionId;
  status: "ok";
};

export type ToolCallMessage = {
  type: "tool_call";
  session_id: SessionId;
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ToolRegistrySnapshotMessage = {
  type: "tool_registry_snapshot";
  session_id: SessionId;
  tools: ToolDescriptor[];
};

export type ToolRegistryDeltaMessage = {
  type: "tool_registry_delta";
  session_id: SessionId;
  operation: "upsert" | "remove";
  tool?: ToolDescriptor;
  name?: string;
};

export type ToolResultMessage = {
  type: "tool_result";
  session_id: SessionId;
  id: string;
  result: unknown;
};

export type ToolErrorMessage = {
  type: "tool_error";
  session_id: SessionId;
  id: string;
  error: {
    type:
      | "tool_not_found"
      | "tool_input_validation_error"
      | "tool_output_validation_error"
      | "tool_execution_error"
      | "tool_serialization_error"
      | "tool_timeout";
    message: string;
    details?: unknown;
  };
};

export type HandshakeMessage =
  | SessionClaimMessage
  | SessionAckMessage
  | ToolCallMessage
  | ToolRegistrySnapshotMessage
  | ToolRegistryDeltaMessage
  | ToolResultMessage
  | ToolErrorMessage;

export const isSessionBoundMessage = (value: unknown): value is SessionBoundMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  return typeof message.type === "string" && typeof message.session_id === "string";
};

const SESSION_CLAIM_DEVICE_WIRE_KEYS = [
  ["device_manufacturer", "manufacturer"],
  ["device_model", "model"],
  ["device_os", "os"],
] as const;

/**
 * Returns `undefined` when the claim omits all device fields.
 * Returns `"invalid"` when any present device field is not a string within the length limit.
 */
export const parseSessionClaimDeviceFields = (
  message: Record<string, unknown>,
): SessionClaimDeviceInfo | undefined | "invalid" => {
  let anyDeviceKey = false;
  const out: SessionClaimDeviceInfo = {};

  for (const [wireKey, outKey] of SESSION_CLAIM_DEVICE_WIRE_KEYS) {
    if (!Object.hasOwn(message, wireKey)) {
      continue;
    }

    anyDeviceKey = true;
    const raw = message[wireKey];

    if (typeof raw !== "string" || raw.length > SESSION_CLAIM_DEVICE_FIELD_MAX_LENGTH) {
      return "invalid";
    }

    out[outKey] = raw;
  }

  return anyDeviceKey ? out : undefined;
};

export const isSessionClaimMessage = (value: unknown): value is SessionClaimMessage => {
  if (!isSessionBoundMessage(value)) {
    return false;
  }

  const message = value as unknown as Record<string, unknown>;

  if (value.type !== "session_claim" || typeof message.token !== "string") {
    return false;
  }

  const deviceParse = parseSessionClaimDeviceFields(message);

  return deviceParse !== "invalid";
};

export const isSessionAckMessage = (value: unknown): value is SessionAckMessage => {
  if (!isSessionBoundMessage(value)) {
    return false;
  }

  const message = value as unknown as Record<string, unknown>;

  return value.type === "session_ack" && message.status === "ok";
};

export const isToolCallMessage = (value: unknown): value is ToolCallMessage => {
  if (!isSessionBoundMessage(value)) {
    return false;
  }

  const message = value as unknown as Record<string, unknown>;

  return (
    message.type === "tool_call" &&
    typeof message.id === "string" &&
    typeof message.name === "string" &&
    typeof message.args === "object" &&
    message.args !== null
  );
};

export const isToolRegistrySnapshotMessage = (value: unknown): value is ToolRegistrySnapshotMessage => {
  if (!isSessionBoundMessage(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;

  return message.type === "tool_registry_snapshot" && Array.isArray(message.tools);
};

export const isToolRegistryDeltaMessage = (value: unknown): value is ToolRegistryDeltaMessage => {
  if (!isSessionBoundMessage(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (message.type !== "tool_registry_delta") {
    return false;
  }

  if (message.operation === "upsert") {
    return typeof message.tool === "object" && message.tool !== null;
  }

  if (message.operation === "remove") {
    return typeof message.name === "string";
  }

  return false;
};

export const isToolResultMessage = (value: unknown): value is ToolResultMessage => {
  if (!isSessionBoundMessage(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;

  return message.type === "tool_result" && typeof message.id === "string" && "result" in message;
};

export const isToolErrorMessage = (value: unknown): value is ToolErrorMessage => {
  if (!isSessionBoundMessage(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;
  const error = message.error;

  return (
    message.type === "tool_error" &&
    typeof message.id === "string" &&
    typeof error === "object" &&
    error !== null &&
    typeof (error as Record<string, unknown>).type === "string" &&
    typeof (error as Record<string, unknown>).message === "string"
  );
};
