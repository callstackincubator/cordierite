/**
 * `daemon.log` rotation (ARCHITECTURE.md §3/§4, issue #32). The daemon's stdout/stderr is appended
 * to `daemon.log` for the whole life of the process, so nothing inside a running daemon can safely
 * truncate it — the only safe moment is just before a *new* daemon is spawned, while no writer
 * holds the file open. {@link rotateDaemonLogIfNeeded} is therefore called from the spawn path
 * (`rpc/client.ts`'s `defaultSpawn`, which is also what `cordierite daemon start` spawns through),
 * never from the daemon itself. The spawn path is reached only when no daemon answered the socket
 * and this process won the exclusive spawn lock, so in practice nothing is holding the log. The
 * one gap is the pre-existing double-spawn window (the lock is released once the child is
 * spawned, before its socket is up): a second spawner there could rename the log of a daemon that
 * is still booting, which keeps writing into `daemon.log.1` through its inherited fd. Bounded and
 * benign — no lines are lost, and a just-booted daemon's log is far below any sane cap anyway.
 *
 * One backup is enough (`daemon.log.1`): the point is a bounded footprint, not a full history. A
 * rotation failure is warned and swallowed — a daemon that cannot rotate its log must still start.
 */

import { chmod, rename, stat } from "node:fs/promises";

import { DEFAULT_DAEMON_LOG_MAX_BYTES, loadConfig } from "./config.js";
import { getStateDirPaths } from "./state-dir.js";

/** Mode every file under the state dir is held at (ARCHITECTURE.md §3). */
const STATE_FILE_MODE = 0o600;

export const daemonLogBackupPath = (logFilePath: string): string => `${logFilePath}.1`;

export type RotateDaemonLogOptions = {
  logFilePath: string;
  /** Rotate once the log is strictly larger than this. */
  maxBytes: number;
  /** Sink for rotation-failure diagnostics; defaults to `process.stderr`. Injectable for tests. */
  warn?: (message: string) => void;
};

export type RotateDaemonLogResult = {
  rotated: boolean;
  /** Size of the log that was moved aside; only set when `rotated` is `true`. */
  rotatedBytes?: number;
};

/**
 * Moves `daemon.log` to `daemon.log.1` when it exceeds `maxBytes`, replacing any previous backup.
 * A missing log, a log within the cap, or any failure is a no-op — never throws.
 */
export const rotateDaemonLogIfNeeded = async (
  options: RotateDaemonLogOptions,
): Promise<RotateDaemonLogResult> => {
  const warn =
    options.warn ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });

  try {
    const stats = await stat(options.logFilePath);

    if (!stats.isFile() || stats.size <= options.maxBytes) {
      return { rotated: false };
    }

    const backupPath = daemonLogBackupPath(options.logFilePath);
    // `rename` is atomic within the state dir, so a concurrent spawner either sees the old log or
    // the rotated one — never a half-copied file. It also preserves the log's mode; the explicit
    // chmod only defends against a backup that predates this code (or an operator's `cp`).
    await rename(options.logFilePath, backupPath);
    await chmod(backupPath, STATE_FILE_MODE);

    return { rotated: true, rotatedBytes: stats.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { rotated: false };
    }

    warn(`cordierite: failed to rotate "${options.logFilePath}": ${(error as Error).message}`);

    return { rotated: false };
  }
};

/**
 * `config.daemonLogMaxBytes` for a state dir, falling back to the default when `config.json` is
 * missing or unreadable. Deliberately forgiving: this runs on the spawn path, where a bad config
 * is the daemon's problem to report properly once it starts — not a reason to fail rotation (and
 * with it the spawn) with a duplicate error.
 */
export const resolveDaemonLogMaxBytes = async (stateDir: string): Promise<number> => {
  try {
    return (await loadConfig(getStateDirPaths(stateDir))).daemonLogMaxBytes;
  } catch {
    return DEFAULT_DAEMON_LOG_MAX_BYTES;
  }
};
