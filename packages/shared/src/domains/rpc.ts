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
  toolsCancel: "tools.cancel",
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

/** Wire-safe mirror of `daemon/config.ts`'s `PolicyDecision` (ARCHITECTURE.md §12). */
export type EffectivePolicyDecision = "allow" | "deny" | "prompt";

/** Wire-safe mirror of `daemon/config.ts`'s `CordieritePolicyConfig` (ARCHITECTURE.md §12):
 * `daemon.status`'s effective policy, exactly as loaded from `config.json` plus defaults. */
export type EffectivePolicyConfig = {
  default: EffectivePolicyDecision;
  destructive: EffectivePolicyDecision;
  tools?: Record<string, EffectivePolicyDecision>;
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

/** A `tools.list` entry: the tool's descriptor plus the policy decision (ARCHITECTURE.md §12)
 * that would apply to it right now — resolved daemon-side (it needs `session.alias` and
 * `config.policy`) so the MCP server can emit `_meta["anthropic/requiresUserInteraction"]` for
 * `"prompt"` tools at `tools/list` time without a second round trip. */
export type ToolsListEntry = ToolDescriptor & {
  policy: EffectivePolicyDecision;
};

export type ToolsListResult = ToolsListEntry[];

export type ToolsCallParams = SessionSelectorParams & {
  name: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  /** Attribution for the audit log (ARCHITECTURE.md §12): who issued this call. The MCP server
   * always sets `"mcp"`; omitted (the CLI's case) defaults to `"cli"` at the daemon. */
  caller?: "cli" | "mcp";
  /**
   * Set by this codebase's own MCP server, and only when all of: (a) this tool's effective policy
   * is `"prompt"`, (b) the server emitted `_meta["anthropic/requiresUserInteraction"]` for it in
   * this connection's most recent `tools/list` response, and (c) the connected client's
   * `initialize` `clientInfo` is one known to enforce that flag (`name === "claude-code"`, version
   * ≥ 2.1.199). The daemon trusts this param verbatim once present — it is the sole evidence a
   * human gate exists for a `"prompt"`-policy call, and everything else (CLI, a non-compliant MCP
   * client) is denied (`policy_denied`, reason `no_consent_channel`). The daemon cannot itself
   * re-verify an MCP client's behavior, so this is not a defense against another local process
   * (one with access to the same `daemon.sock`) sending this param directly — see
   * `docs/SECURITY.md`'s threat model, which already treats socket access as full daemon control.
   * `"prompt"` fails closed by design: see issue #14 / ARCHITECTURE.md §12.
   */
  consent?: "client";
};

export type ToolsCallResult = {
  result: unknown;
  /** The `tool_call`/`tool_call_progress`/`tool_call_finished` correlation id (ARCHITECTURE.md
   * §7's `call_…` id), exposed so a caller with several in-flight `tools.call`s (e.g. the MCP
   * server proxying concurrent `tools/call` requests) can match its own call to the progress events
   * it sees on `events.subscribe` without guessing from data shape. */
  callId: string;
};

// --- tools.cancel ---

export type ToolsCancelParams = SessionSelectorParams & {
  /** The `callId` returned by the `tools.call` this cancels. */
  callId: string;
  reason?: string;
};

export type ToolsCancelResult = {
  /** `false` when `callId` was unknown or already finished — a no-op, not an error. */
  cancelled: boolean;
};

// --- events.subscribe ---

export type EventKind =
  | "daemon_started"
  | "link_created"
  | "link_expired"
  | "session_claimed"
  | "session_suspended"
  | "session_resumed"
  | "session_revoked"
  | "session_expired"
  | "tools_changed"
  | "app_event"
  | "tool_call_started"
  | "tool_call_progress"
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
