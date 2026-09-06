/**
 * CLI command-result types (ARCHITECTURE.md §10). The v2 command table replaces the v1 shapes that
 * used to live here (`host`/`connect`/`session` — all removed from the v2 command surface) with
 * the thin-client shapes for the v2 command table.
 */

import type { OpenTarget } from "./open-target.js";
import type {
  AgentEndpoint,
  EffectivePolicyDecision,
  EventNotification,
  SessionSummary,
  ToolDescriptor,
} from "@cordierite/shared";

/**
 * CLI-domain error classes, used only to pick a sysexits-style exit code (see `errors.ts`).
 * `CliError.type` itself is *not* restricted to this union: RPC/app-originated failures preserve
 * the daemon's wire `ErrorType` verbatim in `type` (ARCHITECTURE.md §5 — "never re-wrapped"), while
 * CLI-originated failures (bad flags, JSON parse errors, ...) use one of these names directly.
 */
export type CliErrorType =
  | "usage_error"
  | "validation_error"
  | "connection_error"
  | "session_error"
  | "tool_error"
  | "permission_error"
  | "internal_error"
  // `doctor`-specific: a tool was missing or an artifact could not be read/parsed (see
  // `artifact-inspect.ts`'s doc comment for why this must never collapse into "absent").
  | "inspection_error"
  // `doctor --assert-present`/`--assert-absent`: inspection succeeded but the assertion failed.
  | "assertion_error";

export type CliError = {
  /** A `CliErrorType` for CLI-originated failures, or the verbatim daemon/app `ErrorType` for
   * RPC-originated ones (e.g. `tool_execution_error`) — never re-wrapped under a generic type. */
  type: string;
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

export type KeygenCommandData = {
  path: string;
  pin: string;
};

export type LinkCommandData = {
  sessionId: string;
  /** Already includes the `pin` query param (see `pin` below) alongside `cordierite`. */
  deepLink: string;
  endpoint: AgentEndpoint;
  /** Unix seconds. */
  expiresAt: number;
  /** The daemon's SPKI pin, same value as embedded in `deepLink`'s `pin` query param — surfaced
   * as its own field for `--json` consumers that don't want to re-parse the URL (opt-in
   * hardening dev-mode: native clients trust this only in debug builds with no `cliPins`). */
  pin: string;
  /** Present (and `true`) only once `--open <target>` has successfully delivered the link
   * (ARCHITECTURE.md §10). */
  delivered?: true;
  /** The `--open` target the link was delivered to, alongside `delivered`. */
  target?: OpenTarget;
};

/** `cordierite ls`: `sessions.list` passthrough, verbatim (ARCHITECTURE.md §10: "--json passthrough"). */
export type LsCommandData = SessionSummary[];

/** `cordierite tools`: the full list, or a single descriptor when a tool name resolved to a detail lookup. */
export type ToolsCommandData = ToolDescriptor[] | ToolDescriptor;

/** `cordierite invoke`: the tool's raw result payload, printed as-is. */
export type InvokeCommandData = unknown;

export type RevokeCommandData = {
  ok: true;
};

/** A single `cordierite events` line, in both human and NDJSON (`--json`) rendering. */
export type EventsCommandLine = EventNotification;

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

/** `cordierite doctor <artifact>`: artifact-level Cordierite inclusion report (docs/tasks/08). */
export type DoctorCommandData = {
  artifact: string;
  platform: "ios" | "android";
  format: "app" | "ipa" | "apk" | "aab";
  present: boolean;
  /** Which specific markers matched; empty when `present` is `false`. */
  signals: string[];
  /** Present only when `--assert-present`/`--assert-absent` was given. `holds` is always `true` on
   * a successful result — a failed assertion throws instead (see `assertion_error`), so a caller
   * reading only `ok: true` results never needs to re-check this field to know whether the gate
   * passed. */
  assertion?: {
    expected: "present" | "absent";
    holds: true;
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
  /**
   * Present only when the running daemon's version differs from this CLI's (issue #30). `daemon
   * status` deliberately reports drift instead of acting on it — it is the command an operator
   * reaches for to *diagnose* a daemon, so it must never restart the one they are inspecting.
   */
  warning?: string;
  /** Effective policy + audit surfacing (ARCHITECTURE.md §12). */
  policy: {
    default: EffectivePolicyDecision;
    destructive: EffectivePolicyDecision;
    tools?: Record<string, EffectivePolicyDecision>;
  };
  /**
   * `path`/`failed_writes` come from every daemon version. The retention fields are optional
   * because a daemon started before retention existed answers `daemon.status` without them, and a
   * newer CLI can be pointed at exactly that daemon. Absent is reported as absent — omitted from
   * `--json` and skipped in the human rendering — rather than defaulted to `0`, which would state
   * "this daemon retains nothing and has zero day files" when the truth is that it was never
   * asked. `daemon.version` is the field that explains why they are missing.
   */
  audit: {
    path: string;
    failed_writes: number;
    failed_prunes?: number;
    retention_days?: number;
    /** Retained `audit/<YYYY-MM-DD>.jsonl` day files. */
    files?: number;
    /** Total bytes across those files. */
    bytes?: number;
  };
};
