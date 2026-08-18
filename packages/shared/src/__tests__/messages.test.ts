import { describe, expect, test } from "vitest";

import {
  isEventMessage,
  isKnownWireMessageType,
  isSessionAckMessage,
  isSessionClaimMessage,
  isSessionResumeMessage,
  isToolCallMessage,
  isToolCallProgressMessage,
  isToolCancelMessage,
  isToolErrorMessage,
  isToolRegistryDeltaMessage,
  isToolRegistrySnapshotMessage,
  isToolResultMessage,
  isWireMessage,
  MAX_WIRE_STRING_LENGTH,
  type EventMessage,
  type SessionAckMessage,
  type SessionClaimMessage,
  type SessionResumeMessage,
  type ToolCallMessage,
  type ToolCallProgressMessage,
  type ToolCancelMessage,
  type ToolErrorMessage,
  type ToolRegistryRemoveDeltaMessage,
  type ToolRegistrySnapshotMessage,
  type ToolRegistryUpsertDeltaMessage,
  type ToolResultMessage,
} from "../domains/messages.js";

const validClaim = (): SessionClaimMessage => ({
  type: "session_claim",
  protocol_version: 2,
  session_id: "session-1",
  token: "token-base64url",
});

const validResume = (): SessionResumeMessage => ({
  type: "session_resume",
  protocol_version: 2,
  session_id: "session-1",
  resume_token: "resume-base64url",
});

const validAck = (): SessionAckMessage => ({
  type: "session_ack",
  session_id: "session-1",
  status: "ok",
  alias: "pixel-8",
  resume_token: "resume-base64url",
  keepalive_interval_s: 15,
  grace_s: 600,
});

const validSnapshot = (): ToolRegistrySnapshotMessage => ({
  type: "tool_registry_snapshot",
  session_id: "session-1",
  tools: [{ name: "ping", description: "Pings." }],
});

const validDeltaUpsert = (): ToolRegistryUpsertDeltaMessage => ({
  type: "tool_registry_delta",
  session_id: "session-1",
  operation: "upsert",
  tool: { name: "ping", description: "Pings." },
});

const validDeltaRemove = (): ToolRegistryRemoveDeltaMessage => ({
  type: "tool_registry_delta",
  session_id: "session-1",
  operation: "remove",
  name: "ping",
});

const validToolCall = (): ToolCallMessage => ({
  type: "tool_call",
  session_id: "session-1",
  id: "call-1",
  name: "ping",
  args: {},
});

const validToolResult = (): ToolResultMessage => ({
  type: "tool_result",
  session_id: "session-1",
  id: "call-1",
  result: { ok: true },
});

const validToolError = (): ToolErrorMessage => ({
  type: "tool_error",
  session_id: "session-1",
  id: "call-1",
  error: { type: "tool_not_found", message: "not found" },
});

const validProgress = (): ToolCallProgressMessage => ({
  type: "tool_call_progress",
  session_id: "session-1",
  id: "call-1",
  progress: 0.5,
  message: "halfway",
});

const validCancel = (): ToolCancelMessage => ({
  type: "tool_cancel",
  session_id: "session-1",
  id: "call-1",
  reason: "client_cancelled",
});

const validEvent = (): EventMessage => ({
  type: "event",
  session_id: "session-1",
  name: "app_ready",
  payload: { ok: true },
  ts: 1_700_000_000_000,
});

describe("session_claim", () => {
  test("accepts a valid message", () => {
    expect(isSessionClaimMessage(validClaim())).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isSessionClaimMessage({ ...validClaim(), type: "session_resume" })).toBe(false);
  });

  test("rejects a missing field", () => {
    const { token: _token, ...rest } = validClaim();
    expect(isSessionClaimMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type", () => {
    expect(isSessionClaimMessage({ ...validClaim(), token: 12345 })).toBe(false);
  });

  test("rejects an oversized device field", () => {
    expect(isSessionClaimMessage({ ...validClaim(), device_model: "x".repeat(257) })).toBe(false);
  });

  test("rejects protocol_version !== 2", () => {
    expect(isSessionClaimMessage({ ...validClaim(), protocol_version: 1 })).toBe(false);
  });

  test("accepts optional device fields within the limit", () => {
    expect(
      isSessionClaimMessage({
        ...validClaim(),
        device_manufacturer: "Acme",
        device_model: "Phone",
        device_os: "OS 1",
      }),
    ).toBe(true);
  });
});

describe("session_resume", () => {
  test("accepts a valid message", () => {
    expect(isSessionResumeMessage(validResume())).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isSessionResumeMessage({ ...validResume(), type: "session_claim" })).toBe(false);
  });

  test("rejects a missing field", () => {
    const { resume_token: _resumeToken, ...rest } = validResume();
    expect(isSessionResumeMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type", () => {
    expect(isSessionResumeMessage({ ...validResume(), resume_token: null })).toBe(false);
  });

  test("rejects protocol_version !== 2", () => {
    expect(isSessionResumeMessage({ ...validResume(), protocol_version: 1 })).toBe(false);
  });
});

describe("session_ack", () => {
  test("accepts a valid message", () => {
    expect(isSessionAckMessage(validAck())).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isSessionAckMessage({ ...validAck(), type: "event" })).toBe(false);
  });

  test("rejects a missing field", () => {
    const { alias: _alias, ...rest } = validAck();
    expect(isSessionAckMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type", () => {
    expect(isSessionAckMessage({ ...validAck(), keepalive_interval_s: "15" })).toBe(false);
  });
});

describe("tool_registry_snapshot", () => {
  test("accepts a valid message", () => {
    expect(isToolRegistrySnapshotMessage(validSnapshot())).toBe(true);
  });

  test("accepts an empty tool list", () => {
    expect(isToolRegistrySnapshotMessage({ ...validSnapshot(), tools: [] })).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isToolRegistrySnapshotMessage({ ...validSnapshot(), type: "tool_registry_delta" })).toBe(false);
  });

  test("rejects a missing field", () => {
    const { tools: _tools, ...rest } = validSnapshot();
    expect(isToolRegistrySnapshotMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type (tools not an array)", () => {
    expect(isToolRegistrySnapshotMessage({ ...validSnapshot(), tools: {} })).toBe(false);
  });

  test("rejects a [null] tools element without throwing", () => {
    expect(() => isToolRegistrySnapshotMessage({ ...validSnapshot(), tools: [null] })).not.toThrow();
    expect(isToolRegistrySnapshotMessage({ ...validSnapshot(), tools: [null] })).toBe(false);
  });

  test("rejects a tools element missing required fields", () => {
    expect(isToolRegistrySnapshotMessage({ ...validSnapshot(), tools: [{ name: "ping" }] })).toBe(false);
  });
});

describe("tool_registry_delta", () => {
  test("accepts a valid upsert message", () => {
    expect(isToolRegistryDeltaMessage(validDeltaUpsert())).toBe(true);
  });

  test("accepts a valid remove message", () => {
    expect(isToolRegistryDeltaMessage(validDeltaRemove())).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isToolRegistryDeltaMessage({ ...validDeltaUpsert(), type: "tool_registry_snapshot" })).toBe(false);
  });

  test("rejects a missing field (tool) on upsert", () => {
    const { tool: _tool, ...rest } = validDeltaUpsert();
    expect(isToolRegistryDeltaMessage(rest)).toBe(false);
  });

  test("rejects a missing field (name) on remove", () => {
    const { name: _name, ...rest } = validDeltaRemove();
    expect(isToolRegistryDeltaMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type (tool not an object) on upsert", () => {
    expect(isToolRegistryDeltaMessage({ ...validDeltaUpsert(), tool: "ping" })).toBe(false);
  });

  test("rejects an invalid tool descriptor on upsert without throwing", () => {
    expect(() => isToolRegistryDeltaMessage({ ...validDeltaUpsert(), tool: null })).not.toThrow();
    expect(isToolRegistryDeltaMessage({ ...validDeltaUpsert(), tool: null })).toBe(false);
  });

  test("rejects an unknown operation", () => {
    expect(isToolRegistryDeltaMessage({ ...validDeltaUpsert(), operation: "replace" })).toBe(false);
  });
});

describe("tool_call", () => {
  test("accepts a valid message", () => {
    expect(isToolCallMessage(validToolCall())).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isToolCallMessage({ ...validToolCall(), type: "tool_result" })).toBe(false);
  });

  test("rejects a missing field", () => {
    const { name: _name, ...rest } = validToolCall();
    expect(isToolCallMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type (args not an object)", () => {
    expect(isToolCallMessage({ ...validToolCall(), args: "not-an-object" })).toBe(false);
  });

  test("rejects an oversized name", () => {
    expect(isToolCallMessage({ ...validToolCall(), name: "x".repeat(MAX_WIRE_STRING_LENGTH + 1) })).toBe(false);
  });
});

describe("tool_result", () => {
  test("accepts a valid message", () => {
    expect(isToolResultMessage(validToolResult())).toBe(true);
  });

  test("accepts a null/undefined result as long as the key is present", () => {
    expect(isToolResultMessage({ ...validToolResult(), result: null })).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isToolResultMessage({ ...validToolResult(), type: "tool_error" })).toBe(false);
  });

  test("rejects a missing field", () => {
    const { id: _id, ...rest } = validToolResult();
    expect(isToolResultMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type", () => {
    expect(isToolResultMessage({ ...validToolResult(), id: 42 })).toBe(false);
  });
});

describe("tool_error", () => {
  test("accepts a valid message", () => {
    expect(isToolErrorMessage(validToolError())).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isToolErrorMessage({ ...validToolError(), type: "tool_result" })).toBe(false);
  });

  test("rejects a missing field", () => {
    const { error: _error, ...rest } = validToolError();
    expect(isToolErrorMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type (error not an object)", () => {
    expect(isToolErrorMessage({ ...validToolError(), error: "boom" })).toBe(false);
  });

  test("rejects an unknown error.type", () => {
    expect(isToolErrorMessage({ ...validToolError(), error: { type: "not_a_real_type", message: "x" } })).toBe(
      false,
    );
  });

  test("rejects an error.type outside the tool_* subset", () => {
    expect(isToolErrorMessage({ ...validToolError(), error: { type: "policy_denied", message: "x" } })).toBe(
      false,
    );
  });

  test("rejects an oversized error message", () => {
    expect(
      isToolErrorMessage({
        ...validToolError(),
        error: { type: "tool_not_found", message: "x".repeat(MAX_WIRE_STRING_LENGTH + 1) },
      }),
    ).toBe(false);
  });
});

describe("tool_call_progress", () => {
  test("accepts a valid message", () => {
    expect(isToolCallProgressMessage(validProgress())).toBe(true);
  });

  test("accepts a message with both optional fields omitted", () => {
    const { progress: _progress, message: _message, ...rest } = validProgress();
    expect(isToolCallProgressMessage(rest)).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isToolCallProgressMessage({ ...validProgress(), type: "tool_result" })).toBe(false);
  });

  test("rejects a missing required field", () => {
    const { id: _id, ...rest } = validProgress();
    expect(isToolCallProgressMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type", () => {
    expect(isToolCallProgressMessage({ ...validProgress(), progress: "half" })).toBe(false);
  });
});

describe("tool_cancel", () => {
  test("accepts a valid message", () => {
    expect(isToolCancelMessage(validCancel())).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isToolCancelMessage({ ...validCancel(), type: "tool_call" })).toBe(false);
  });

  test("rejects a missing field", () => {
    const { reason: _reason, ...rest } = validCancel();
    expect(isToolCancelMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type", () => {
    expect(isToolCancelMessage({ ...validCancel(), id: 123 })).toBe(false);
  });

  test("rejects an oversized reason", () => {
    expect(isToolCancelMessage({ ...validCancel(), reason: "x".repeat(MAX_WIRE_STRING_LENGTH + 1) })).toBe(false);
  });
});

describe("event", () => {
  test("accepts a valid message", () => {
    expect(isEventMessage(validEvent())).toBe(true);
  });

  test("rejects the wrong type", () => {
    expect(isEventMessage({ ...validEvent(), type: "tool_call_progress" })).toBe(false);
  });

  test("rejects a missing field", () => {
    const { ts: _ts, ...rest } = validEvent();
    expect(isEventMessage(rest)).toBe(false);
  });

  test("rejects a wrong field type", () => {
    expect(isEventMessage({ ...validEvent(), ts: "now" })).toBe(false);
  });

  test("rejects an oversized name", () => {
    expect(isEventMessage({ ...validEvent(), name: "x".repeat(MAX_WIRE_STRING_LENGTH + 1) })).toBe(false);
  });
});

describe("isKnownWireMessageType / isWireMessage", () => {
  test("accepts every documented message type", () => {
    for (const message of [
      validClaim(),
      validResume(),
      validAck(),
      validSnapshot(),
      validDeltaUpsert(),
      validDeltaRemove(),
      validToolCall(),
      validToolResult(),
      validToolError(),
      validProgress(),
      validCancel(),
      validEvent(),
    ]) {
      expect(isKnownWireMessageType(message.type)).toBe(true);
      expect(isWireMessage(message)).toBe(true);
    }
  });

  test("rejects an unknown extra type", () => {
    expect(isKnownWireMessageType("tool_registry_full_resync")).toBe(false);
    expect(isWireMessage({ type: "tool_registry_full_resync", session_id: "session-1" })).toBe(false);
  });

  test("isWireMessage never throws on hostile input", () => {
    expect(() => isWireMessage(null)).not.toThrow();
    expect(() => isWireMessage(undefined)).not.toThrow();
    expect(() => isWireMessage([1, 2, 3])).not.toThrow();
    expect(() => isWireMessage("hello")).not.toThrow();
    expect(isWireMessage(null)).toBe(false);
  });
});
