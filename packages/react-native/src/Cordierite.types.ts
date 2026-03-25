import type {
  ConnectBootstrapPayload,
  HandshakeMessage,
  StandardSchemaV1,
  SessionBoundMessage,
  SessionId,
  SessionToken,
  ToolCallMessage,
  ToolDescriptor,
  ToolErrorMessage,
  ToolResultMessage,
} from "@cordierite/shared";

/** Mirrors native connection lifecycle; see `cordieriteClient.connect` JSDoc for promise semantics. */
export type CordieriteConnectionState =
  | "idle"
  | "connecting"
  | "active"
  | "closed"
  | "error";

/**
 * Options passed to the TurboModule `connect` method (same shape as a validated bootstrap payload
 * plus optional device metadata). Must stay aligned with `CordieriteConnectOptionsNative` in
 * `NativeCordierite.ts` (Codegen).
 */
export type CordieriteConnectOptions = {
  ip: string;
  port: number;
  sessionId: SessionId;
  token: SessionToken;
  expiresAt: number;
  /** Optional overrides for `session_claim`; native fills defaults when omitted. */
  deviceManufacturer?: string;
  deviceModel?: string;
  deviceOs?: string;
};

export type CordieriteConnectInput =
  | CordieriteConnectOptions
  | ConnectBootstrapPayload;

/**
 * Parsed JSON from the wire. Non-object or invalid JSON may surface as `{}` (see `CordieriteModule`).
 */
export type CordieriteIncomingMessage =
  | HandshakeMessage
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

export type CordieriteToolExecutionContext = {
  sessionId: SessionId;
  invocationId: string;
  receivedAt: string;
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
  descriptor: ToolDescriptor;
  inputSchema?: CordieriteRuntimeSchema;
  outputSchema?: CordieriteRuntimeSchema;
  handler: CordieriteToolHandler;
};

export class CordieriteBootstrapParseError extends Error {
  code: CordieriteBootstrapParseErrorCode;

  constructor(code: CordieriteBootstrapParseErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CordieriteBootstrapParseError";
  }
}
