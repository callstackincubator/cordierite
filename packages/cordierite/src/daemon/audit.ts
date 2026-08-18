/**
 * Append-only per-day audit log (ARCHITECTURE.md §3, §12): one JSONL line per `tools.call`
 * attempt (CLI and MCP alike), regardless of outcome. Raw args are **never** written — only a hex
 * sha256 digest of their canonical JSON, so an operator can correlate repeated/identical calls
 * without the log becoming a second copy of whatever secrets a tool's arguments carried.
 *
 * Writes are serialized through an internal promise queue so a slow disk never blocks the
 * `tools.call` response path: {@link AuditLogger.record} enqueues and returns immediately. A write
 * failure never throws back into the call path — it is logged to stderr and counted in
 * {@link AuditLogger.failedWrites} (surfaced via `daemon.status`, ARCHITECTURE.md §12 item 4).
 * {@link AuditLogger.flush} lets the daemon's shutdown teardown wait for the queue to drain.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import type { ErrorType } from "@cordierite/shared";

import type { Clock } from "../cli/types.js";

export type AuditOutcome = "ok" | "error" | "denied" | "cancelled";
export type AuditCaller = "cli" | "mcp";

export type AuditRecord = {
  /** ISO 8601. */
  ts: string;
  sessionId: string;
  alias: string;
  tool: string;
  /** Hex sha256 of the canonical JSON of the call's `args` — raw args are never logged. */
  argsSha256: string;
  outcome: AuditOutcome;
  errorType?: ErrorType;
  /**
   * Set only when `outcome === "denied"`: `"policy"` for an ordinary `policy.*: "deny"` denial,
   * `"no_consent_channel"` for a `"prompt"`-policy call that had no confirmed human gate
   * (ARCHITECTURE.md §12). Without this an operator reading `audit/*.jsonl` can't tell a
   * misconfigured `"deny"` from a `"prompt"` tool nobody has gated yet — both otherwise look like
   * an identical `{ outcome: "denied" }` line.
   */
  deniedReason?: "policy" | "no_consent_channel";
  durationMs: number;
  caller: AuditCaller;
  /**
   * Set only when a `"prompt"`-policy call actually proceeded because the MCP server confirmed a
   * client-side consent gate (ARCHITECTURE.md §12). Deliberately distinct from a plain `"ok"`:
   * the daemon never observed the consent decision itself, only that the call arrived carrying
   * this marker — this is the weakest form of evidence (issue #14), and the audit record should
   * read as such rather than folding it into an ordinary allow.
   */
  consent?: "client";
};

export type AuditLogger = {
  /** Enqueues one JSONL line for the day derived from the current clock; returns immediately
   * (fire-and-forget from the caller's perspective — see the module doc comment). */
  record: (entry: Omit<AuditRecord, "ts">) => void;
  /** Count of write failures since the logger was created (never resets). */
  failedWrites: () => number;
  /** Resolves once every queued write so far has settled (success or logged failure). */
  flush: () => Promise<void>;
};

export type AuditLoggerOptions = {
  auditDir: string;
  clock?: Clock;
  /** Sink for write-failure diagnostics; defaults to `process.stderr`. Injectable for tests. */
  warn?: (message: string) => void;
};

/** Recursively sorts object keys so semantically-identical args always hash identically,
 * regardless of the property insertion order the caller happened to use. */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }

  return value;
};

export const canonicalArgsJson = (args: Record<string, unknown>): string => {
  return JSON.stringify(canonicalize(args));
};

export const argsSha256 = (args: Record<string, unknown>): string => {
  return createHash("sha256").update(canonicalArgsJson(args)).digest("hex");
};

const auditFilePathForDate = (auditDir: string, date: Date): string => {
  const dateStamp = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(auditDir, `${dateStamp}.jsonl`);
};

const appendLine = async (filePath: string, line: string): Promise<void> => {
  const handle = await open(filePath, "a", 0o600);

  try {
    await handle.appendFile(line);
    // `open`'s mode only applies at creation and is further subject to umask; chmod explicitly so
    // an existing (or umask-widened) file always ends up at the ARCHITECTURE.md §3 mode.
    await chmod(filePath, 0o600);
  } finally {
    await handle.close();
  }
};

export const createAuditLogger = (options: AuditLoggerOptions): AuditLogger => {
  const clock = options.clock ?? { now: () => new Date() };
  const warn =
    options.warn ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });

  let failedWrites = 0;
  let queue: Promise<void> = Promise.resolve();

  const record = (entry: Omit<AuditRecord, "ts">): void => {
    const now = clock.now();
    const full: AuditRecord = { ts: now.toISOString(), ...entry };
    const line = `${JSON.stringify(full)}\n`;
    const filePath = auditFilePathForDate(options.auditDir, now);

    // Chained onto the existing queue tail so writes for the same (or different) day never race
    // each other; a failure is swallowed here (never rejects the chain) so one bad write can't
    // poison every audit record after it.
    queue = queue.then(async () => {
      try {
        await mkdir(options.auditDir, { recursive: true });
        await appendLine(filePath, line);
      } catch (error) {
        failedWrites += 1;
        warn(`cordierite daemon: failed to write an audit record: ${(error as Error).message}`);
      }
    });
  };

  return {
    record,
    failedWrites: () => failedWrites,
    flush: () => queue,
  };
};
