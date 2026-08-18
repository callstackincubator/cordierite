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
  eventsSince: "events.since",
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

/** Wire-safe mirror of `daemon/config.ts`'s `CordieritePolicyConfig` (ARCHITECTURE.md §12):
 * `daemon.status`'s effective policy, exactly as loaded from `config.json` plus defaults. */
export type EffectivePolicyConfig = {
  default: "allow" | "deny";
  destructive: "allow" | "deny";
  tools?: Record<string, "allow" | "deny">;
};

export type DaemonStatusResult = {
  version: string;
  pid: number;
  /** ISO 8601. */
  startedAt: string;
  wssPort: number;
  pinnedKeys: string[];
  sessions: SessionSummary[];
  /** Effective policy configuration (ARCHITECTURE.md §12). */
  policy: EffectivePolicyConfig;
  /** Audit log surfacing (ARCHITECTURE.md §12): where records land and how many writes failed. */
  audit: {
    path: string;
    failedWrites: number;
  };
};

// --- daemon.shutdown ---

export type DaemonShutdownResult = { ok: true };

// --- link.create ---

export type LinkCreateParams = {
  ttlSeconds?: number;
  /** Forces the advertised address encoded into the bootstrap payload (ARCHITECTURE.md §8's
   * emulator/simulator fast path: `127.0.0.1`, since the wss listener already binds all
   * interfaces). Omitted for the normal LAN/QR delivery path. */
  addressOverride?: string;
};

export type LinkCreateResult = {
  sessionId: string;
  /** Base64url bootstrap blob; callers compose `<scheme>:///?cordierite=<deepLinkPayload>`. */
  deepLinkPayload: string;
  endpoint: AgentEndpoint;
  /** Unix seconds. */
  expiresAt: number;
  /**
   * The daemon's SPKI pin (`sha256/<44-char-base64>`, same value as `daemon.status`'s
   * `pinnedKeys[0]` / `cordierite keygen`'s output), composed by callers into the deep link's
   * separate `pin` query param, alongside the existing `cordierite` bootstrap blob (see
   * ARCHITECTURE.md §8 for that blob's binary layout, unchanged here). Old apps must keep
   * ignoring this param. Native clients only trust it when built in debug mode with no
   * build-time `cliPins` configured; embedded pins always win.
   */
  pin: string;
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
  /** Attribution for the audit log (ARCHITECTURE.md §12): who issued this call. The MCP server
   * always sets `"mcp"`; omitted (the CLI's case) defaults to `"cli"` at the daemon. */
  caller?: "cli" | "mcp";
};

export type ToolsCallResult = {
  result: unknown;
  /** The `tool_call`/`tool_call_progress`/`tool_call_finished` correlation id (ARCHITECTURE.md
   * §7's `call_…` id), exposed so a caller with several in-flight `tools.call`s (e.g. the MCP
   * server proxying concurrent `tools/call` requests) can match its own call to the progress events
   * it sees on `events.subscribe` without guessing from data shape. */
  callId: string;
};

// --- events.subscribe ---

/** The single source of truth for the `EventKind` union below — a `const` array (not just a type)
 * so runtime validators (the daemon's `events.subscribe`/`events.since` param parsing, the MCP
 * `cordierite_events`/`cordierite_wait_for_event` tool schemas) can derive their allow-list from it
 * instead of hand-maintaining a second copy that can silently drift from this type. */
export const EVENT_KINDS = [
  "daemon_started",
  "link_created",
  "link_expired",
  "session_claimed",
  "session_suspended",
  "session_resumed",
  "session_revoked",
  "session_expired",
  "tools_changed",
  "app_event",
  "tool_call_started",
  "tool_call_progress",
  "tool_call_finished",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

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
  /**
   * Monotonically increasing per-session cursor (ARCHITECTURE.md §5), assigned by the daemon-side
   * retention buffer at emit time. Only meaningful for session-scoped events (`sessionId` set) —
   * daemon-wide events (e.g. `daemon_started`) are never buffered and carry `seq: 0`. Pass the
   * highest `seq` seen back into `events.since`'s `since` to resume after it.
   */
  seq: number;
};

// --- events.since ---

/** Pulls events retained in the daemon's per-session ring buffer (ARCHITECTURE.md §5) — the
 * request/response counterpart to `events.subscribe`'s push model, for callers (MCP tools, a
 * scripted `cordierite events --since`) that ask "what happened?" after the fact instead of
 * listening live. */
export type EventsSinceParams = {
  /** Session id or alias; omitted selects the sole active/suspended session (same default as
   * `SessionSelectorParams`). */
  selector?: string;
  /** Exclusive lower bound on `EventNotification.seq`; omitted returns the whole retained buffer
   * (oldest first, subject to `limit`). */
  since?: number;
  kinds?: EventKind[];
  /** Caps the number of events returned (newest-first truncation); omitted returns everything
   * matching `since`/`kinds` up to the buffer's own retention limit. */
  limit?: number;
};

export type EventsSinceResult = {
  events: EventNotification[];
  /** The highest `seq` currently retained for this session (not just among the returned events),
   * so a caller can pass it straight back into the next `since` even when `limit` truncated the
   * response or nothing new had happened. */
  cursor: number;
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
