import type { ErrorType } from "./errors.js";
import type { AgentEndpoint } from "./transport.js";
import type { ToolDescriptor } from "./tool-descriptor.js";

/** Control-plane RPC method name constants (ARCHITECTURE.md §5). Types only — no transport here. */
export const RPC_METHODS = {
  daemonStatus: "daemon.status",
  daemonShutdown: "daemon.shutdown",
  linkCreate: "link.create",
  sessionsList: "sessions.list",
  sessionsDescribe: "sessions.describe",
  sessionsRevoke: "sessions.revoke",
  toolsList: "tools.list",
  toolsCall: "tools.call",
  eventsSubscribe: "events.subscribe",
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

/** ARCHITECTURE.md §6 session state machine. */
export type SessionState = "pending" | "active" | "suspended" | "discarded" | "expired" | "revoked";

export type SessionDeviceMetadata = {
  manufacturer?: string;
  model?: string;
  os?: string;
};

export type SessionSummary = {
  sessionId: string;
  alias: string;
  state: SessionState;
  device: SessionDeviceMetadata;
  /** ISO 8601. */
  createdAt: string;
  claimedAt?: string;
  suspendedAt?: string;
  toolCount: number;
};

/** `sessions.describe` returns full session detail; today that is the same shape as `SessionSummary`. */
export type SessionDetail = SessionSummary;

export type SessionSelectorParams = {
  /** Session id or alias; omitted selects the sole active/suspended session (or errors — §5). */
  selector?: string;
};

// --- daemon.status ---

export type DaemonStatusResult = {
  version: string;
  pid: number;
  /** ISO 8601. */
  startedAt: string;
  wssPort: number;
  pinnedKeys: string[];
  sessions: SessionSummary[];
};

// --- daemon.shutdown ---

export type DaemonShutdownResult = { ok: true };

// --- link.create ---

export type LinkCreateParams = {
  ttlSeconds?: number;
};

export type LinkCreateResult = {
  sessionId: string;
  /** Base64url bootstrap blob; callers compose `<scheme>:///?cordierite=<deepLinkPayload>`. */
  deepLinkPayload: string;
  endpoint: AgentEndpoint;
  /** Unix seconds. */
  expiresAt: number;
};

// --- sessions.list / sessions.describe / sessions.revoke ---

export type SessionsListResult = SessionSummary[];

export type SessionsDescribeParams = SessionSelectorParams;
export type SessionsDescribeResult = SessionDetail;

export type SessionsRevokeParams = SessionSelectorParams;
export type SessionsRevokeResult = { ok: true };

// --- tools.list / tools.call ---

export type ToolsListParams = SessionSelectorParams;
export type ToolsListResult = ToolDescriptor[];

export type ToolsCallParams = SessionSelectorParams & {
  name: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
};

export type ToolsCallResult = { result: unknown };

// --- events.subscribe ---

export type EventKind =
  | "daemon_started"
  | "link_created"
  | "session_claimed"
  | "session_suspended"
  | "session_resumed"
  | "session_revoked"
  | "session_expired"
  | "tools_changed"
  | "app_event"
  | "tool_call_started"
  | "tool_call_finished";

export type EventsSubscribeParams = {
  sessionSelector?: string;
  kinds?: EventKind[];
};

export type EventsSubscribeResult = { ok: true };

/** Server→client `event` notification payload pushed on any connection with an active subscription. */
export type EventNotification = {
  kind: EventKind;
  sessionId?: string;
  alias?: string;
  /** Unix ms. */
  ts: number;
  data: unknown;
};

// --- JSON-RPC 2.0 error shape ---

/** `error.data.type` preserves the wire/app error type verbatim end-to-end (never re-wrapped). */
export type RpcErrorData = {
  type: ErrorType;
  [key: string]: unknown;
};

export type RpcError = {
  code: number;
  message: string;
  data?: RpcErrorData;
};
