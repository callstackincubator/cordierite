import type {
  BootstrapPayload,
  SessionBoundMessage,
  SessionId,
  StandardSchemaV1,
  StandardSchemaV1JsonSchema,
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

/**
 * Effective trust/pin configuration this build was compiled with — read from the TurboModule's
 * `getConstants()`, which pulls from the exact same manifest/plist keys `resolveTrustedPins`
 * (`docs/tasks/05-explicit-trust-mode.md`) reads on both platforms, never a second parse. `trust`
 * is normally `"link"` or `"pin"` (the effective bucket — `"pin"` whenever embedded pins are
 * present, since they always win regardless of the raw config value); a hand-edited native config
 * with an unrecognized `trust` string surfaces that raw string here instead of being silently
 * coerced. On the `./noop` entry (no native module in this build) `trust` is the sentinel
 * `"absent"`, distinct from any real value, and `hasEmbeddedPins`/`allowPrivateLanOnly` do not
 * describe a real build — see `noop.ts`'s `getCordieriteBuildConfig`. Pin fingerprints themselves
 * are never exposed, only whether any are embedded.
 */
export type CordieriteBuildConfig = {
  trust: string;
  hasEmbeddedPins: boolean;
  allowPrivateLanOnly: boolean;
};

/** A decoded v2 bootstrap payload, plus the deep link's optional sibling `pin` param (see
 * `CordieriteConnectOptions.linkPin`) — `bootstrap.ts`'s `parseBootstrapUrl` produces this shape. */
export type CordieriteBootstrapConnectInput = BootstrapPayload & { linkPin?: string };

export type CordieriteConnectInput =
  | CordieriteConnectOptions
  | CordieriteBootstrapConnectInput;

/** Per-call options for `connect()`, distinct from the payload being connected with. */
export type CordieriteConnectCallOptions = {
  /**
   * Replace a session that is already connecting or active instead of throwing.
   *
   * Reserved for a freshly delivered bootstrap deep link: something with local access to this
   * device just asked for *this* session, which outranks whatever is currently held (commonly a
   * lease restored after a Metro reload, possibly pointing at a daemon that no longer exists).
   * The existing connection is closed only after the new payload validates.
   */
  supersede?: boolean;
};

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
  /** Aborted when the daemon sends `tool_cancel` for this call, or when the session suspends
   * mid-call. Handlers may ignore it — they then run to completion as before. */
  signal: AbortSignal;
};

export type CordieriteToolHandler<TArgs = unknown, TResult = unknown> = (
  args: TArgs,
  context: CordieriteToolExecutionContext
) => TResult | Promise<TResult>;

/**
 * A raw JSON Schema object handed straight to `inputSchema`/`outputSchema` (ARCHITECTURE.md §11).
 *
 * Recognised at runtime purely by the *absence* of `~standard`, so any plain object works — there
 * is no wrapper to import. It is forwarded to the daemon verbatim and **never validated app-side**:
 * a handler with a raw input schema receives `tool_call.args` exactly as the caller sent them.
 *
 * The type parameter is phantom (never present at runtime). It is set only by the `jsonSchema<T>()`
 * helper below, which is how a raw schema still gets real handler argument/result types; a bare
 * object literal infers `Record<string, unknown>` instead. There is one phantom slot, carrying the
 * type the *handler* sees for whichever of the two slots the schema is used in.
 *
 * A JSON Schema value typed as an interface (`JSONSchema7` from `@types/json-schema`, say) is not
 * assignable to `Record<string, unknown>` — TypeScript gives implicit index signatures to type
 * aliases, not interfaces. Wrap it in `jsonSchema<T>()` or cast it.
 */
export type CordieriteJsonSchemaObject<T = unknown> = Record<string, unknown> & {
  /** Phantom marker; `jsonSchema<T>()` only casts, it never writes this property. */
  readonly "~cordieriteJsonSchemaType"?: T;
};

/**
 * `{ input, output }` JSON Schema exporter — the same shape Standard JSON Schema puts on
 * `~standard.jsonSchema`. Accepted as the `jsonSchema` half of a {@link CordieritePairedSchema} so
 * one converter (e.g. a `zod-to-json-schema` wrapper) can serve both slots.
 */
export type CordieriteJsonSchemaConverter = StandardSchemaV1JsonSchema.Converter;

/**
 * A Standard Schema paired with the JSON Schema to publish for it — the supported form for
 * libraries that validate but cannot export JSON Schema themselves (zod 3, plain valibot, arktype
 * without an adapter).
 *
 * `schema` still drives runtime validation (`~standard.validate`), so handler argument and result
 * types are inferred exactly as they are for zod 4. `jsonSchema` is either a ready JSON Schema
 * object or an `{ input, output }` converter; only the half matching the slot this pair is used in
 * is ever called.
 */
export type CordieritePairedSchema<Input = unknown, Output = Input> = {
  readonly schema: StandardSchemaV1<Input, Output>;
  readonly jsonSchema: Record<string, unknown> | CordieriteJsonSchemaConverter;
};

/**
 * Everything `inputSchema`/`outputSchema` accept (ARCHITECTURE.md §11): a Standard Schema (with or
 * without a `~standard.jsonSchema` exporter), a `{ schema, jsonSchema }` pair, or a raw JSON Schema
 * object.
 *
 * All three members carry the annotation's types, so an explicitly annotated
 * `CordieriteRuntimeSchema<Args>` still gives the handler exactly `Args` — the raw member is
 * parameterized precisely so it cannot widen that back to `Record<string, unknown>`.
 */
export type CordieriteRuntimeSchema<Input = unknown, Output = Input> =
  | StandardSchemaV1<Input, Output>
  | CordieritePairedSchema<Input, Output>
  | CordieriteJsonSchemaObject<Output>;

/**
 * Tags a raw JSON Schema object with the argument/result type its handler should see. Purely a
 * type-level cast — the object is returned unchanged, nothing is validated, and no runtime check
 * ever confirms that `T` matches the schema.
 *
 * ```ts
 * inputSchema: jsonSchema<{ city: string }>({
 *   type: "object",
 *   properties: { city: { type: "string" } },
 *   required: ["city"],
 * })
 * ```
 */
export const jsonSchema = <T = Record<string, unknown>>(
  schema: Record<string, unknown>
): CordieriteJsonSchemaObject<T> => schema as CordieriteJsonSchemaObject<T>;

/**
 * Runtime shape an `inputSchema`/`outputSchema` takes once `normalizeToolSchema` (`schema.ts`) has
 * classified it. Stored on {@link CordieriteRegisteredTool} so export and validation never re-sniff
 * the user's value.
 */
export type CordieriteNormalizedToolSchema =
  | { kind: "standard"; schema: StandardSchemaV1 }
  | {
      kind: "paired";
      schema: StandardSchemaV1;
      jsonSchema: Record<string, unknown> | CordieriteJsonSchemaConverter;
    }
  | { kind: "raw"; jsonSchema: Record<string, unknown> };

/**
 * Handler argument type for an `inputSchema`. Paired and plain Standard Schemas both infer the
 * schema's *output* (post-validation) type; a raw JSON Schema infers whatever `jsonSchema<T>()`
 * declared, or `Record<string, unknown>` for a bare object.
 *
 * `InferToolArgs<undefined>` is `undefined`. Note that a registration that simply *omits*
 * `inputSchema` gives its handler `unknown`, not `undefined`: with no property to infer from,
 * `registerTool`'s type parameter falls back to its constraint
 * (`CordieriteRuntimeSchema | undefined`), and this type distributes over that union. That has
 * always been the behaviour and is unchanged here.
 */
export type InferToolArgs<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : TSchema extends { readonly schema: infer S extends StandardSchemaV1 }
    ? StandardSchemaV1.InferOutput<S>
    : TSchema extends CordieriteJsonSchemaObject<infer T>
      ? unknown extends T
        ? Record<string, unknown>
        : T
      : undefined;

/**
 * Handler result type for an `outputSchema` — the mirror of {@link InferToolArgs}, using the
 * schema's *input* (pre-validation) type so a handler may return whatever the schema accepts.
 */
export type InferToolResult<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<TSchema>
  : TSchema extends { readonly schema: infer S extends StandardSchemaV1 }
    ? StandardSchemaV1.InferInput<S>
    : TSchema extends CordieriteJsonSchemaObject<infer T>
      ? unknown extends T
        ? Record<string, unknown>
        : T
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
  /** Normalized at registration time (`schema.ts`'s `normalizeToolSchema`), never the raw user value. */
  inputSchema?: CordieriteNormalizedToolSchema;
  outputSchema?: CordieriteNormalizedToolSchema;
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
