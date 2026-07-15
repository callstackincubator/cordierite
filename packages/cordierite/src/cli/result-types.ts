/**
 * CLI command-result types.
 *
 * These lived in `@cordierite/shared`'s v1 `cli.ts` module. `@cordierite/shared` is now the v2
 * wire-protocol package only (task 02 of the v2 refactor; see `docs/ARCHITECTURE.md` §13) and no
 * longer exports CLI-output-specific shapes, so they live here instead, next to the renderer/CLI
 * code that is their only consumer. Task 06 (CLI v2) owns redesigning the CLI surface and its
 * command-result shapes; until then this preserves the current `keygen` command output unchanged.
 */

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

export type ToolsCommandData = {
  tools: import("@cordierite/shared").ToolDescriptor[];
  selected_tool?: import("@cordierite/shared").ToolDescriptor;
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

export type DaemonRunCommandData = {
  daemon: {
    pid: number;
    state_dir: string;
    socket_path: string;
  };
};

export type DaemonStartCommandData = {
  daemon: {
    pid: number;
    wss_port: number;
    started_at: string;
  };
};

export type DaemonStopCommandData = {
  daemon: {
    ok: true;
    /** How the daemon was told to stop: a clean RPC round-trip, or a SIGTERM fallback. */
    method: "rpc" | "sigterm";
  };
};

export type DaemonStatusCommandData = {
  daemon: {
    version: string;
    pid: number;
    started_at: string;
    wss_port: number;
    pinned_keys: string[];
    session_count: number;
  };
};
