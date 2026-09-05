/**
 * Audit retention (ARCHITECTURE.md §3): `AuditLogger.prune` deletes day files older than
 * `auditRetentionDays`, and `AuditLogger.stats` reports the directory's footprint for
 * `daemon.status`. Every case here drives a real temp directory with an injected clock, so the
 * day-boundary arithmetic is exercised against the exact file names the writer produces rather
 * than against wall time.
 *
 * `node:fs/promises` is mocked only to make one specific `rm` fail (the "counted, not thrown"
 * case); every other call falls through to the real implementation.
 */

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createAuditLogger, type AuditLogger } from "../daemon/audit.js";
import type { Clock } from "../cli/types.js";

const mocked = vi.hoisted(() => ({ failingBasenames: new Set<string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    rm: async (target: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (typeof target === "string" && mocked.failingBasenames.has(path.basename(target))) {
        throw new Error("simulated unlink failure");
      }

      return actual.rm(target, options);
    },
  };
});

const auditDirs: string[] = [];

afterEach(async () => {
  mocked.failingBasenames.clear();

  while (auditDirs.length > 0) {
    await rm(auditDirs.pop()!, { force: true, recursive: true });
  }
});

const makeAuditDir = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "cordierite-audit-retention-"));
  auditDirs.push(root);
  const auditDir = path.join(root, "audit");
  await mkdir(auditDir, { recursive: true });
  return auditDir;
};

/** A clock the test moves by hand; `now` is always read fresh so `record`/`prune` see the
 * current value rather than one captured at construction. */
const createTestClock = (iso: string): Clock & { set: (next: string) => void } => {
  let current = new Date(iso);

  return {
    now: () => new Date(current),
    set: (next: string) => {
      current = new Date(next);
    },
  };
};

const writeDayFile = async (auditDir: string, name: string, contents = "{}\n"): Promise<void> => {
  await writeFile(path.join(auditDir, name), contents, { mode: 0o600 });
};

const listNames = async (auditDir: string): Promise<string[]> => {
  return (await readdir(auditDir)).sort();
};

const createLogger = (
  auditDir: string,
  clock: Clock,
  retentionDays: number,
  warnings: string[] = [],
): AuditLogger => {
  return createAuditLogger({
    auditDir,
    clock,
    retentionDays,
    warn: (message) => warnings.push(message),
  });
};

describe("audit retention: pruning", () => {
  test("deletes only day files older than the retention window", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2026-09-05T12:00:00.000Z");

    // With retentionDays = 30 the oldest retained day is 2026-08-06: 2026-08-05 is the first day
    // that is *more* than 30 days behind today.
    await writeDayFile(auditDir, "2026-09-05.jsonl"); // today
    await writeDayFile(auditDir, "2026-09-04.jsonl"); // yesterday
    await writeDayFile(auditDir, "2026-08-06.jsonl"); // exactly at the edge — retained
    await writeDayFile(auditDir, "2026-08-05.jsonl"); // one day past the edge — pruned
    await writeDayFile(auditDir, "2025-09-05.jsonl"); // a year old — pruned

    const logger = createLogger(auditDir, clock, 30);

    await expect(logger.prune()).resolves.toEqual({ deleted: 2, failed: 0 });
    expect(await listNames(auditDir)).toEqual(["2026-08-06.jsonl", "2026-09-04.jsonl", "2026-09-05.jsonl"]);
    expect(logger.failedPrunes()).toBe(0);
  });

  test("never deletes today's file, even at the tightest retention", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2026-09-05T23:59:59.999Z");

    await writeDayFile(auditDir, "2026-09-05.jsonl");
    await writeDayFile(auditDir, "2026-09-04.jsonl");
    await writeDayFile(auditDir, "2026-09-03.jsonl");

    const logger = createLogger(auditDir, clock, 1);

    await expect(logger.prune()).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(await listNames(auditDir)).toEqual(["2026-09-04.jsonl", "2026-09-05.jsonl"]);
  });

  test("the day file the writer just produced is the one pruning keeps (same UTC boundary)", async () => {
    const auditDir = await makeAuditDir();
    // Late UTC evening on the 31st: in a west-of-UTC local zone this instant is still the 31st,
    // in an east-of-UTC one it is already the 1st. The writer names files off `toISOString`, so
    // the pruner must use the same UTC calendar day or it would delete a file being appended to.
    const clock = createTestClock("2025-12-31T23:30:00.000Z");
    const logger = createLogger(auditDir, clock, 1);

    logger.record({
      sessionId: "s-1",
      alias: "pixel-8",
      tool: "echo",
      argsSha256: "0".repeat(64),
      outcome: "ok",
      durationMs: 1,
      caller: "cli",
    });
    await logger.flush();

    expect(await listNames(auditDir)).toEqual(["2025-12-31.jsonl"]);

    await writeDayFile(auditDir, "2025-12-29.jsonl");
    await expect(logger.prune()).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(await listNames(auditDir)).toEqual(["2025-12-31.jsonl"]);

    // Half an hour later the UTC day has rolled over; yesterday's file is retained (it is exactly
    // one day behind) and the writer starts a new one.
    clock.set("2026-01-01T00:00:01.000Z");
    await expect(logger.prune()).resolves.toEqual({ deleted: 0, failed: 0 });
    expect(await listNames(auditDir)).toEqual(["2025-12-31.jsonl"]);
  });

  test("touches nothing that is not an `<YYYY-MM-DD>.jsonl` day file", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2026-09-05T12:00:00.000Z");

    await writeDayFile(auditDir, "2020-01-01.jsonl"); // the only real candidate
    await writeDayFile(auditDir, "2020-01-02.jsonl.bak"); // an operator's copy
    await writeDayFile(auditDir, "2020-13-45.jsonl"); // matches the shape, is not a date
    await writeDayFile(auditDir, "audit.jsonl");
    await writeDayFile(auditDir, "notes.txt");
    await writeDayFile(auditDir, "2020-01-03.JSONL");
    await mkdir(path.join(auditDir, "2020-01-04.jsonl"), { recursive: true }); // a directory

    const logger = createLogger(auditDir, clock, 30);

    await expect(logger.prune()).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(await listNames(auditDir)).toEqual([
      "2020-01-02.jsonl.bak",
      "2020-01-03.JSONL",
      "2020-01-04.jsonl",
      "2020-13-45.jsonl",
      "audit.jsonl",
      "notes.txt",
    ]);
  });

  test("a retention window wider than the Date range keeps everything instead of throwing", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2026-09-05T12:00:00.000Z");

    await writeDayFile(auditDir, "1970-01-01.jsonl");
    await writeDayFile(auditDir, "2026-09-05.jsonl");

    // A positive integer, so config validation accepts it — but far enough back to run off the
    // end of the representable `Date` range.
    const logger = createLogger(auditDir, clock, Number.MAX_SAFE_INTEGER);

    await expect(logger.prune()).resolves.toEqual({ deleted: 0, failed: 0 });
    expect(await listNames(auditDir)).toEqual(["1970-01-01.jsonl", "2026-09-05.jsonl"]);
    expect(logger.failedPrunes()).toBe(0);
  });

  test("an empty or missing audit directory prunes to a no-op", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2026-09-05T12:00:00.000Z");

    await expect(createLogger(auditDir, clock, 30).prune()).resolves.toEqual({ deleted: 0, failed: 0 });

    const missing = path.join(auditDir, "does-not-exist");
    const missingLogger = createLogger(missing, clock, 30);

    await expect(missingLogger.prune()).resolves.toEqual({ deleted: 0, failed: 0 });
    await expect(missingLogger.stats()).resolves.toEqual({ files: 0, bytes: 0 });
    expect(missingLogger.failedPrunes()).toBe(0);
  });

  test("a delete failure is counted and warned, never thrown", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2026-09-05T12:00:00.000Z");
    const warnings: string[] = [];

    await writeDayFile(auditDir, "2020-01-01.jsonl");
    await writeDayFile(auditDir, "2020-01-02.jsonl");
    mocked.failingBasenames.add("2020-01-01.jsonl");

    const logger = createLogger(auditDir, clock, 30, warnings);

    // The failure neither rejects nor stops the sweep: the other stale file is still deleted.
    await expect(logger.prune()).resolves.toEqual({ deleted: 1, failed: 1 });
    expect(logger.failedPrunes()).toBe(1);
    expect(warnings.some((message) => message.includes("2020-01-01.jsonl"))).toBe(true);
    expect(await listNames(auditDir)).toEqual(["2020-01-01.jsonl"]);

    // The counter accumulates across sweeps and the logger stays usable.
    await expect(logger.prune()).resolves.toEqual({ deleted: 0, failed: 1 });
    expect(logger.failedPrunes()).toBe(2);
    expect(logger.failedWrites()).toBe(0);
  });

  test("pruning runs on the write queue, so it never races an in-flight append", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2020-01-01T00:00:00.000Z");
    const logger = createLogger(auditDir, clock, 30);

    // Enqueue a write dated well outside the retention window, then — without awaiting it — a
    // prune. The prune must observe the finished write and delete the file it created.
    logger.record({
      sessionId: "s-1",
      alias: "pixel-8",
      tool: "echo",
      argsSha256: "0".repeat(64),
      outcome: "ok",
      durationMs: 1,
      caller: "cli",
    });
    clock.set("2026-09-05T12:00:00.000Z");

    await expect(logger.prune()).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(await listNames(auditDir)).toEqual([]);
    expect(logger.failedWrites()).toBe(0);
  });

  test("day files stay 0600 across a prune that spares them", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2026-09-05T12:00:00.000Z");

    await writeDayFile(auditDir, "2026-09-05.jsonl");
    await writeDayFile(auditDir, "2020-01-01.jsonl");

    await createLogger(auditDir, clock, 30).prune();

    expect((await stat(path.join(auditDir, "2026-09-05.jsonl"))).mode & 0o777).toBe(0o600);
  });
});

describe("audit retention: stats", () => {
  test("counts and sizes only the day files", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2026-09-05T12:00:00.000Z");

    await writeDayFile(auditDir, "2026-09-05.jsonl", "a".repeat(10));
    await writeDayFile(auditDir, "2026-09-04.jsonl", "b".repeat(15));
    await writeDayFile(auditDir, "notes.txt", "c".repeat(1000));

    await expect(createLogger(auditDir, clock, 30).stats()).resolves.toEqual({ files: 2, bytes: 25 });
  });

  test("shrinks after a prune", async () => {
    const auditDir = await makeAuditDir();
    const clock = createTestClock("2026-09-05T12:00:00.000Z");

    await writeDayFile(auditDir, "2026-09-05.jsonl", "a".repeat(10));
    await writeDayFile(auditDir, "2020-01-01.jsonl", "b".repeat(90));

    const logger = createLogger(auditDir, clock, 30);

    await expect(logger.stats()).resolves.toEqual({ files: 2, bytes: 100 });
    await logger.prune();
    await expect(logger.stats()).resolves.toEqual({ files: 1, bytes: 10 });
  });
});
