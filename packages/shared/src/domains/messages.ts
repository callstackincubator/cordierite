import { isToolErrorType } from "./errors.js";
import { isToolDescriptor, type ToolDescriptor } from "./tool-descriptor.js";

export const PROTOCOL_VERSION = 2;

/** Max length per optional `session_claim` device field (JSON string, UTF-16 code units). */
export const SESSION_CLAIM_DEVICE_FIELD_MAX_LENGTH = 256;

/** Generic bound for otherwise-unbounded untrusted string fields (error messages, event names). */
export const MAX_WIRE_STRING_LENGTH = 4096;

/** Bound for wire ids (`session_id`, `tool_call` ids, tokens as base64url text). */
export const MAX_WIRE_ID_LENGTH = 128;

export type SessionId = string;

/** Minimal structural shape shared by every post-claim message: `{ type, session_id }`. */
export type SessionBoundMessage = {
  type: string;
  session_id: SessionId;
};

/**
 * Loose structural guard used by clients composing *arbitrary* outbound frames (e.g. custom
 * `event` payloads) that only need to confirm a `session_id` is present before comparing it to the
 * active session — not a substitute for the strict per-type guards below.
 */
export const isSessionBoundMessage = (value: unknown): value is SessionBoundMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  return typeof message.type === "string" && typeof message.session_id === "string";
};

export type SessionClaimDeviceInfo = {
  manufacturer?: string;
  model?: string;
  os?: string;
};

export type SessionClaimMessage = {
  type: "session_claim";
  protocol_version: 2;
  session_id: SessionId;
  /** Base64url, 32 raw bytes. */
  token: string;
  device_manufacturer?: string;
  device_model?: string;
  device_os?: string;
};

export type SessionResumeMessage = {
  type: "session_resume";
  protocol_version: 2;
  session_id: SessionId;
  /** Base64url, 32 raw bytes. */
  resume_token: string;
};

export type SessionAckMessage = {
  type: "session_ack";
  session_id: SessionId;
  status: "ok";
  alias: string;
  resume_token: string;
  keepalive_interval_s: number;
  grace_s: number;
};

export type ToolRegistrySnapshotMessage = {
  type: "tool_registry_snapshot";
  session_id: SessionId;
  tools: ToolDescriptor[];
};

export type ToolRegistryUpsertDeltaMessage = {
  type: "tool_registry_delta";
  session_id: SessionId;
  operation: "upsert";
  tool: ToolDescriptor;
};

export type ToolRegistryRemoveDeltaMessage = {
  type: "tool_registry_delta";
  session_id: SessionId;
  operation: "remove";
  name: string;
};

export type ToolRegistryDeltaMessage = ToolRegistryUpsertDeltaMessage | ToolRegistryRemoveDeltaMessage;

export type ToolCallMessage = {
  type: "tool_call";
  session_id: SessionId;
  id: string;
  name: string;
  args: Record<string, unknown>;
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

export type ToolCallProgressMessage = {
  type: "tool_call_progress";
  session_id: SessionId;
  id: string;
  progress?: number;
  message?: string;
};

export type ToolCancelMessage = {
  type: "tool_cancel";
  session_id: SessionId;
  id: string;
  reason: string;
};

export type EventMessage = {
  type: "event";
  session_id: SessionId;
  name: string;
  payload?: unknown;
  ts: number;
};

/** Every v2 wire message, in both directions. */
export type WireMessage =
  | SessionClaimMessage
  | SessionResumeMessage
  | SessionAckMessage
  | ToolRegistrySnapshotMessage
  | ToolRegistryDeltaMessage
  | ToolCallMessage
  | ToolResultMessage
  | ToolErrorMessage
  | ToolCallProgressMessage
  | ToolCancelMessage
  | EventMessage;

// --- shared field validators ---

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isBoundedString = (value: unknown, maxLength: number): value is string => {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
};

const isBoundedNonEmptySessionId = (value: unknown): value is string => {
  return isBoundedString(value, MAX_WIRE_ID_LENGTH);
};

const SESSION_CLAIM_DEVICE_WIRE_KEYS = [
  ["device_manufacturer", "manufacturer"],
  ["device_model", "model"],
  ["device_os", "os"],
] as const;

/**
 * Returns `undefined` when the claim omits all device fields, the parsed fields when all present
 * ones are valid, or `"invalid"` when any present device field is not a string within the length
 * limit.
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
  if (!isRecord(value) || value.type !== "session_claim") {
    return false;
  }

  if (value.protocol_version !== PROTOCOL_VERSION) {
    return false;
  }

  if (!isBoundedNonEmptySessionId(value.session_id)) {
    return false;
  }

  if (!isBoundedString(value.token, MAX_WIRE_ID_LENGTH)) {
    return false;
  }

  return parseSessionClaimDeviceFields(value) !== "invalid";
};

export const isSessionResumeMessage = (value: unknown): value is SessionResumeMessage => {
  if (!isRecord(value) || value.type !== "session_resume") {
    return false;
  }

  return (
    value.protocol_version === PROTOCOL_VERSION &&
    isBoundedNonEmptySessionId(value.session_id) &&
    isBoundedString(value.resume_token, MAX_WIRE_ID_LENGTH)
  );
};

export const isSessionAckMessage = (value: unknown): value is SessionAckMessage => {
  if (!isRecord(value) || value.type !== "session_ack") {
    return false;
  }

  return (
    value.status === "ok" &&
    isBoundedNonEmptySessionId(value.session_id) &&
    isBoundedString(value.alias, MAX_WIRE_ID_LENGTH) &&
    isBoundedString(value.resume_token, MAX_WIRE_ID_LENGTH) &&
    typeof value.keepalive_interval_s === "number" &&
    Number.isFinite(value.keepalive_interval_s) &&
    typeof value.grace_s === "number" &&
    Number.isFinite(value.grace_s)
  );
};

export const isToolRegistrySnapshotMessage = (value: unknown): value is ToolRegistrySnapshotMessage => {
  if (!isRecord(value) || value.type !== "tool_registry_snapshot") {
    return false;
  }

  if (!isBoundedNonEmptySessionId(value.session_id) || !Array.isArray(value.tools)) {
    return false;
  }

  // Never index into unvalidated data: every element must itself pass the descriptor guard.
  return value.tools.every((tool) => isToolDescriptor(tool));
};

export const isToolRegistryDeltaMessage = (value: unknown): value is ToolRegistryDeltaMessage => {
  if (!isRecord(value) || value.type !== "tool_registry_delta") {
    return false;
  }

  if (!isBoundedNonEmptySessionId(value.session_id)) {
    return false;
  }

  if (value.operation === "upsert") {
    return isToolDescriptor(value.tool);
  }

  if (value.operation === "remove") {
    return isBoundedString(value.name, MAX_WIRE_STRING_LENGTH);
  }

  return false;
};

export const isToolCallMessage = (value: unknown): value is ToolCallMessage => {
  if (!isRecord(value) || value.type !== "tool_call") {
    return false;
  }

  return (
    isBoundedNonEmptySessionId(value.session_id) &&
    isBoundedString(value.id, MAX_WIRE_ID_LENGTH) &&
    isBoundedString(value.name, MAX_WIRE_STRING_LENGTH) &&
    isRecord(value.args)
  );
};

export const isToolResultMessage = (value: unknown): value is ToolResultMessage => {
  if (!isRecord(value) || value.type !== "tool_result") {
    return false;
  }

  return isBoundedNonEmptySessionId(value.session_id) && isBoundedString(value.id, MAX_WIRE_ID_LENGTH) && "result" in value;
};

export const isToolErrorMessage = (value: unknown): value is ToolErrorMessage => {
  if (!isRecord(value) || value.type !== "tool_error") {
    return false;
  }

  if (!isBoundedNonEmptySessionId(value.session_id) || !isBoundedString(value.id, MAX_WIRE_ID_LENGTH)) {
    return false;
  }

  const error = value.error;

  if (!isRecord(error)) {
    return false;
  }

  return isToolErrorType(error.type) && isBoundedString(error.message, MAX_WIRE_STRING_LENGTH);
};

export const isToolCallProgressMessage = (value: unknown): value is ToolCallProgressMessage => {
  if (!isRecord(value) || value.type !== "tool_call_progress") {
    return false;
  }

  if (!isBoundedNonEmptySessionId(value.session_id) || !isBoundedString(value.id, MAX_WIRE_ID_LENGTH)) {
    return false;
  }

  if (value.progress !== undefined && (typeof value.progress !== "number" || !Number.isFinite(value.progress))) {
    return false;
  }

  if (value.message !== undefined && !isBoundedString(value.message, MAX_WIRE_STRING_LENGTH)) {
    return false;
  }

  return true;
};

export const isToolCancelMessage = (value: unknown): value is ToolCancelMessage => {
  if (!isRecord(value) || value.type !== "tool_cancel") {
    return false;
  }

  return (
    isBoundedNonEmptySessionId(value.session_id) &&
    isBoundedString(value.id, MAX_WIRE_ID_LENGTH) &&
    isBoundedString(value.reason, MAX_WIRE_STRING_LENGTH)
  );
};

export const isEventMessage = (value: unknown): value is EventMessage => {
  if (!isRecord(value) || value.type !== "event") {
    return false;
  }

  if (!isBoundedNonEmptySessionId(value.session_id) || !isBoundedString(value.name, MAX_WIRE_STRING_LENGTH)) {
    return false;
  }

  return typeof value.ts === "number" && Number.isFinite(value.ts);
};

const WIRE_MESSAGE_TYPES = [
  "session_claim",
  "session_resume",
  "session_ack",
  "tool_registry_snapshot",
  "tool_registry_delta",
  "tool_call",
  "tool_result",
  "tool_error",
  "tool_call_progress",
  "tool_cancel",
  "event",
] as const;

const WIRE_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(WIRE_MESSAGE_TYPES);

/** True for any recognized `type` string, without validating the rest of the message. */
export const isKnownWireMessageType = (type: unknown): type is WireMessage["type"] => {
  return typeof type === "string" && WIRE_MESSAGE_TYPE_SET.has(type);
};

const WIRE_MESSAGE_GUARDS: {
  [K in WireMessage["type"]]: (value: unknown) => boolean;
} = {
  session_claim: isSessionClaimMessage,
  session_resume: isSessionResumeMessage,
  session_ack: isSessionAckMessage,
  tool_registry_snapshot: isToolRegistrySnapshotMessage,
  tool_registry_delta: isToolRegistryDeltaMessage,
  tool_call: isToolCallMessage,
  tool_result: isToolResultMessage,
  tool_error: isToolErrorMessage,
  tool_call_progress: isToolCallProgressMessage,
  tool_cancel: isToolCancelMessage,
  event: isEventMessage,
};

/**
 * Full strict guard: unknown `type` (or malformed `type`) is rejected outright — callers on the
 * daemon side should treat that as `unknown_message_type` (close 1008), not a silent ignore.
 */
export const isWireMessage = (value: unknown): value is WireMessage => {
  if (!isRecord(value) || !isKnownWireMessageType(value.type)) {
    return false;
  }

  return WIRE_MESSAGE_GUARDS[value.type](value);
};
