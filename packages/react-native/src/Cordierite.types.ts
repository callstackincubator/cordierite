import type {
  BootstrapPayload,
  SessionBoundMessage,
  SessionId,
  StandardSchemaV1,
  ToolAnnotations,
  ToolCallMessage,
  ToolDescriptor,
  ToolErrorMessage,
  ToolResultMessage,
  WireMessage,
} from "@cordierite/shared";

/** Local app-side ceiling for a tool handler, matching the daemon's `tools.call` default (§5/§11). */
export const CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/** Mirrors the raw native TurboModule connection lifecycle (one native socket, no resume concept). */
export type CordieriteConnectionState =
  | "idle"
  | "connecting"
  | "active"
  | "closed"
  | "error";

/**
 * Unified JS-level client state (ARCHITECTURE.md §11): adds `reconnecting` for the
 * resume/backoff loop that lives entirely in JS, on top of the raw native states above.
 */
export type CordieriteClientState =
  | "idle"
  | "connecting"
  | "active"
  | "reconnecting"
  | "closed";

/**
 * Options passed to the TurboModule `connect` method. Must stay aligned with
 * `CordieriteConnectOptionsNative` in `NativeCordierite.ts` (Codegen).
 *
 * NOTE: the native layer still speaks this single-`ip` shape internally (v1-era claim building);
 * it does not yet carry the v2 bootstrap `family`/`address` split — the JS client maps a v2
 * `BootstrapPayload` (`family`/`address`) onto `ip` before calling native (`connect-helpers.ts`).
 */
export type CordieriteConnectOptions = {
  ip: string;
  port: number;
  sessionId: SessionId;
  /** Base64url, 32 raw bytes. Required unless `resumeToken` is given. */
  token?: string;
  /** Base64url, 32 raw bytes. When present, native sends `session_resume` instead of `session_claim`. */
  resumeToken?: string;
  expiresAt: number;
  /** Optional overrides for `session_claim`; native fills defaults when omitted. */
  deviceManufacturer?: string;
  deviceModel?: string;
  deviceOs?: string;
  /**
   * The bootstrap deep link's separate `pin` query param (`bootstrap.ts`'s `extractLinkPin`),
   * distinct from and never part of the `cordierite` v2 binary payload. Opt-in hardening
   * dev-mode: native only trusts this for the connection when built in debug mode with no
   * build-time `cliPins` configured — embedded pins always win, and release builds without pins
   * keep the existing hard error regardless of `linkPin`.
   */
  linkPin?: string;
};

/** A decoded v2 bootstrap payload, plus the deep link's optional sibling `pin` param (see
 * `CordieriteConnectOptions.linkPin`) — `bootstrap.ts`'s `parseBootstrapUrl` produces this shape. */
export type CordieriteBootstrapConnectInput = BootstrapPayload & { linkPin?: string };

export type CordieriteConnectInput =
  | CordieriteConnectOptions
  | CordieriteBootstrapConnectInput;

/**
 * Parsed JSON from the wire. Non-object or invalid JSON may surface as `{}` (see `CordieriteModule`).
 */
export type CordieriteIncomingMessage =
  | WireMessage
  | SessionBoundMessage
  | Record<string, unknown>;

/**
 * Structured messages accepted by `cordieriteClient.send`. Omit `session_id` to let the client inject
 * the active session.
 *
 * Includes `ToolCallMessage` for advanced/testing scenarios; app code usually sends
 * `tool_result` / `tool_error` or custom `type` payloads.
 */
export type CordieriteStructuredOutboundMessage =
  | ToolCallMessage
  | ToolResultMessage
  | ToolErrorMessage
  | (Record<string, unknown> & {
      type: string;
      session_id?: SessionId;
    });

/**
 * Outbound payload: either a pre-serialized JSON string (must include correct `session_id` when
 * session-bound) or a structured object (session id injected when missing).
 */
export type CordieriteOutboundMessage =
  | string
  | CordieriteStructuredOutboundMessage;

export type CordieriteStateChangeEvent = {
  state: CordieriteConnectionState;
};

export type CordieriteMessageEvent = {
  message: CordieriteIncomingMessage;
  /** Original JSON string from native before parsing. */
  rawMessage: string;
};

export type CordieriteErrorEvent = {
  code: string;
  message: string;
  phase?:
    | "bootstrap"
    | "tls"
    | "connect"
    | "handshake"
    | "session"
    | "transport"
    | "config";
  nativeCode?: string;
  closeReason?: string;
  isRetryable?: boolean;
  hint?: string;
};

export type CordieriteCloseEvent = {
  code?: number;
  reason?: string;
};

/**
 * Subscriptions mirror the native TurboModule events. `message` fires for session-bound JSON after
 * the session is `active` (native validates `session_id`).
 */
export type CordieriteModuleEvents = {
  stateChange: (event: CordieriteStateChangeEvent) => void;
  message: (event: CordieriteMessageEvent) => void;
  error: (event: CordieriteErrorEvent) => void;
  close: (event: CordieriteCloseEvent) => void;
};

export type CordieriteBootstrapParseErrorCode =
  | "invalid_url"
  | "missing_payload"
  | "invalid_payload"
  | "expired_payload";

/** Unified listener kinds (ARCHITECTURE.md §11): `addCordieriteListener(kind, cb)`. */
export type CordieriteListenerKind = "stateChange" | "sessionChange" | "error";

export type CordieriteUnifiedStateChangeEvent = {
  state: CordieriteClientState;
  /** Set on transitions into `closed`/`reconnecting`: `revoked`, `grace_expired`, `closed_by_app`, `socket_error`, `connect_error`, `background`, `foreground`. */
  reason?: string;
};

export type CordieriteSessionChangeEvent = {
  type: "claimed" | "resumed" | "lost";
  sessionId: string | null;
  alias: string | null;
  /** Set when `type` is `"lost"`: `revoked`, `grace_expired`, or `closed_by_app`. */
  reason?: string;
};

/** One error channel for bootstrap parse/connect, socket, and tool-handler failures (§11). */
export type CordieriteUnifiedErrorEvent = {
  phase: "bootstrap" | "connect" | "socket" | "tool";
  message: string;
  cause?: unknown;
  code?: string;
  nativeCode?: string;
  closeReason?: string;
  isRetryable?: boolean;
  hint?: string;
  toolName?: string;
  invocationId?: string;
};

export type CordieriteUnifiedListenerMap = {
  stateChange: (event: CordieriteUnifiedStateChangeEvent) => void;
  sessionChange: (event: CordieriteSessionChangeEvent) => void;
  error: (event: CordieriteUnifiedErrorEvent) => void;
};

/**
 * Reports incremental progress for the in-flight tool call (ARCHITECTURE.md §7's
 * `tool_call_progress` frame). Best-effort: failures are reported on the unified `error` channel
 * (phase `"tool"`), never thrown back into the handler. Both arguments are optional — call with
 * neither to send a bare progress ping.
 */
export type CordieriteReportProgress = (
  progress?: number,
  message?: string
) => Promise<void>;

export type CordieriteToolExecutionContext = {
  sessionId: SessionId;
  invocationId: string;
  receivedAt: string;
  reportProgress: CordieriteReportProgress;
};

export type CordieriteToolHandler<TArgs = unknown, TResult = unknown> = (
  args: TArgs,
  context: CordieriteToolExecutionContext
) => TResult | Promise<TResult>;

export type CordieriteRuntimeSchema<
  Input = unknown,
  Output = Input
> = StandardSchemaV1<Input, Output>;

export type InferToolArgs<TSchema> = TSchema extends CordieriteRuntimeSchema
  ? StandardSchemaV1.InferOutput<TSchema>
  : undefined;

export type InferToolResult<TSchema> = TSchema extends CordieriteRuntimeSchema
  ? StandardSchemaV1.InferInput<TSchema>
  : void;

export type CordieriteToolDefinition<
  TInputSchema extends CordieriteRuntimeSchema | undefined = undefined,
  TOutputSchema extends CordieriteRuntimeSchema | undefined = undefined
> = {
  name: string;
  description: string;
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  annotations?: ToolAnnotations;
  /**
   * Overrides the default 10 s app-side handler timeout (matches the daemon's `tools.call`
   * default ceiling, ARCHITECTURE.md §11). On timeout the app replies `tool_timeout`; a later
   * result from the same invocation is ignored with a dev warning.
   */
  timeoutMs?: number;
};

export type CordieriteToolRegistration<
  TInputSchema extends CordieriteRuntimeSchema | undefined = undefined,
  TOutputSchema extends CordieriteRuntimeSchema | undefined = undefined
> = CordieriteToolDefinition<TInputSchema, TOutputSchema> & {
  handler: CordieriteToolHandler<
    InferToolArgs<TInputSchema>,
    InferToolResult<TOutputSchema>
  >;
};

export type CordieriteRegisteredTool = {
  /** Registration identity: `remove()` disposers compare this, not the tool name (stale-disposer fix). */
  id: symbol;
  descriptor: ToolDescriptor;
  inputSchema?: CordieriteRuntimeSchema;
  outputSchema?: CordieriteRuntimeSchema;
  handler: CordieriteToolHandler;
  timeoutMs: number;
};

export class CordieriteBootstrapParseError extends Error {
  code: CordieriteBootstrapParseErrorCode;

  constructor(code: CordieriteBootstrapParseErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CordieriteBootstrapParseError";
  }
}

/** `connect()` rejects with this on the `./noop` entry (ARCHITECTURE.md §11: compile-out builds). */
export class CordieriteDisabledError extends Error {
  code = "cordierite_disabled" as const;

  constructor() {
    super("Cordierite is disabled in this build (the ./noop entry is in use).");
    this.name = "CordieriteDisabledError";
  }
}
