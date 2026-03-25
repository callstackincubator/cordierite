export type CliErrorType =
  | "usage_error"
  | "validation_error"
  | "connection_error"
  | "session_error"
  | "tool_error"
  | "internal_error";

export type CliError = {
  type: CliErrorType;
  message: string;
  details?: unknown;
};

export type CommandMeta = {
  command: string;
  timestamp: string;
  duration_ms?: number;
};

export type CliSuccessResult<TData> = {
  ok: true;
  data: TData;
  meta?: CommandMeta;
};

export type CliFailureResult = {
  ok: false;
  error: CliError;
  meta?: CommandMeta;
};

export type CliResult<TData> = CliSuccessResult<TData> | CliFailureResult;

export type ConnectCommandData = {
  bootstrap: {
    session_id: string;
    endpoint: {
      ip: string;
      port: number;
      url: string;
    };
    expires_at: number;
    expires_at_iso: string;
    can_claim: boolean;
  };
};

export type SessionListItem = {
  /** Opaque host session id (base64url alphabet; not the WSS port). */
  session_id: string;
  status: "pending" | "active" | "none";
  control_port: number;
  wss_port: number;
  endpoint?: {
    ip: string;
    port: number;
    url: string;
  };
  tool_count: number;
};

export type SessionCommandData = {
  sessions: SessionListItem[];
  /** Present when `cordierite session --session-id <id>` was used */
  selected?: SessionListItem;
};

export type ToolSchemaDescriptor = Record<string, unknown>;

export type ToolDescriptor = {
  name: string;
  description: string;
  input_schema: ToolSchemaDescriptor;
  output_schema: ToolSchemaDescriptor;
};

export type ToolsCommandData = {
  tools: ToolDescriptor[];
  selected_tool?: ToolDescriptor;
};

export type InvokeCommandData = {
  invocation: {
    tool: string;
    result: unknown;
  };
};

export type HostCommandData = {
  host: {
    deep_link: string;
    ttl_seconds: number;
    spki_pin: string;
    /** Opaque session id (base64url-style); use with `--session-id`. */
    session_id: string;
    wss_port: number;
    control_port: number;
  };
};

export type KeygenCommandData = {
  key: {
    path: string;
    spki_pin: string;
    algorithm: "rsa-2048";
  };
};
