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
 *
 * Retention (ARCHITECTURE.md §3): day files older than `config.auditRetentionDays` are deleted by
 * {@link AuditLogger.prune}, which the daemon runs at startup and once a day thereafter. Pruning
 * runs on the same queue as the writes, so it can never race an in-flight append, and its failures
 * are counted in {@link AuditLogger.failedPrunes} and warned rather than thrown — exactly like a
 * failed write.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ErrorType } from "@cordierite/shared";

import type { Clock } from "../cli/types.js";
import { DEFAULT_AUDIT_RETENTION_DAYS } from "./config.js";

export type AuditOutcome = "ok" | "error" | "denied" | "cancelled";
export type AuditCaller = "cli" | "mcp" | "client";

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

/** Audit directory footprint, surfaced by `daemon.status` so the growth is visible (issue #32). */
export type AuditStats = {
  /** Number of `<YYYY-MM-DD>.jsonl` day files currently on disk. */
  files: number;
  /** Total bytes across those files. */
  bytes: number;
};

export type AuditPruneResult = {
  /** Day files deleted by this run. */
  deleted: number;
  /** Day files this run tried and failed to delete (also added to {@link AuditLogger.failedPrunes}). */
  failed: number;
};

export type AuditLogger = {
  /** Enqueues one JSONL line for the day derived from the current clock; returns immediately
   * (fire-and-forget from the caller's perspective — see the module doc comment). */
  record: (entry: Omit<AuditRecord, "ts">) => void;
  /** Count of write failures since the logger was created (never resets). */
  failedWrites: () => number;
  /** Count of prune failures since the logger was created (never resets). */
  failedPrunes: () => number;
  /**
   * Deletes every `<YYYY-MM-DD>.jsonl` day file older than the retention window — never today's,
   * never anything else in the directory. Runs on the write queue and never rejects: failures are
   * counted and warned.
   */
  prune: () => Promise<AuditPruneResult>;
  /** Current day-file count and total size; `{ files: 0, bytes: 0 }` when the directory does not
   * exist yet or cannot be read. */
  stats: () => Promise<AuditStats>;
  /** Resolves once every queued write so far has settled (success or logged failure). */
  flush: () => Promise<void>;
};

export type AuditLoggerOptions = {
  auditDir: string;
  clock?: Clock;
  /** Days of history {@link AuditLogger.prune} keeps; defaults to
   * {@link DEFAULT_AUDIT_RETENTION_DAYS}. */
  retentionDays?: number;
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

/** The UTC day stamp a record written at `date` lands in. UTC (not local time) because that is
 * exactly what the file names have always been derived from — see {@link auditFilePathForDate}. */
const dayStamp = (date: Date): string => {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
};

/** Matches only the day files this module writes. Anything else in `audit/` — an operator's
 * notes, a partial copy, a subdirectory — is never a pruning candidate. */
const AUDIT_DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

/** The captured day stamp when `name` is one of our day files *and* the stamp is a real calendar
 * date (so a plausible-looking `2026-13-45.jsonl` is left alone rather than compared as a string). */
const dayStampOfAuditFile = (name: string): string | undefined => {
  const match = AUDIT_DAY_FILE.exec(name);

  if (!match) {
    return undefined;
  }

  const stamp = match[1]!;
  const parsed = new Date(`${stamp}T00:00:00.000Z`);

  return Number.isNaN(parsed.getTime()) || dayStamp(parsed) !== stamp ? undefined : stamp;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The oldest day stamp retention keeps: `retentionDays` UTC days before the day containing `now`.
 * A day file is pruned when its stamp sorts strictly before this (ISO stamps are zero-padded, so
 * lexicographic order is chronological order), i.e. once it is *more* than `retentionDays` days
 * behind today. Today's file therefore can never be a candidate for any `retentionDays >= 1`.
 */
const oldestRetainedStamp = (now: Date, retentionDays: number): string => {
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return dayStamp(new Date(todayUtcMidnight - retentionDays * MS_PER_DAY));
};

const auditFilePathForDate = (auditDir: string, date: Date): string => {
  return join(auditDir, `${dayStamp(date)}.jsonl`);
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

  const retentionDays = options.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS;

  let failedWrites = 0;
  let failedPrunes = 0;
  let queue: Promise<void> = Promise.resolve();

  /** Lists the day files in the audit directory; an unreadable/missing directory yields `[]`. */
  const listDayFiles = async (): Promise<{ name: string; stamp: string }[]> => {
    let entries;

    try {
      entries = await readdir(options.auditDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: { name: string; stamp: string }[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const stamp = dayStampOfAuditFile(entry.name);

      if (stamp !== undefined) {
        files.push({ name: entry.name, stamp });
      }
    }

    return files;
  };

  const pruneOnce = async (): Promise<AuditPruneResult> => {
    const today = dayStamp(clock.now());
    const cutoff = oldestRetainedStamp(clock.now(), retentionDays);

    let deleted = 0;
    let failed = 0;

    for (const file of await listDayFiles()) {
      // Belt and braces: `cutoff` is already strictly behind `today` for every valid
      // `retentionDays`, but today's file is the one file that must never disappear from under an
      // open append, so it is excluded explicitly (issue #32).
      if (file.stamp === today || file.stamp >= cutoff) {
        continue;
      }

      try {
        await rm(join(options.auditDir, file.name), { force: true });
        deleted += 1;
      } catch (error) {
        failed += 1;
        failedPrunes += 1;
        warn(`cordierite daemon: failed to prune the audit record "${file.name}": ${(error as Error).message}`);
      }
    }

    return { deleted, failed };
  };

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

  /**
   * Chained onto the write queue for the same reason the writes are chained onto each other: a
   * prune must never interleave with the append it would otherwise delete out from under. The
   * returned promise resolves with this prune's own result while the queue itself stays a
   * never-rejecting `Promise<void>` that `flush` can keep awaiting.
   */
  const prune = (): Promise<AuditPruneResult> => {
    let settle!: (result: AuditPruneResult) => void;
    const result = new Promise<AuditPruneResult>((resolve) => {
      settle = resolve;
    });

    queue = queue.then(async () => {
      try {
        settle(await pruneOnce());
      } catch (error) {
        // `pruneOnce` handles per-file failures itself; this only catches a failure of the listing
        // step, which must still never reject the queue.
        failedPrunes += 1;
        warn(`cordierite daemon: failed to prune the audit log: ${(error as Error).message}`);
        settle({ deleted: 0, failed: 1 });
      }
    });

    return result;
  };

  const stats = async (): Promise<AuditStats> => {
    let files = 0;
    let bytes = 0;

    for (const file of await listDayFiles()) {
      try {
        bytes += (await stat(join(options.auditDir, file.name))).size;
        files += 1;
      } catch {
        // Raced with a prune (ours or an operator's `rm`); an audit record that is gone by the
        // time it is measured simply does not count toward the reported footprint.
      }
    }

    return { files, bytes };
  };

  return {
    record,
    failedWrites: () => failedWrites,
    failedPrunes: () => failedPrunes,
    prune,
    stats,
    flush: () => queue,
  };
};
