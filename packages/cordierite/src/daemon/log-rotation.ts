/**
 * `daemon.log` rotation (ARCHITECTURE.md §3/§4, issue #32). The daemon's stdout/stderr is appended
 * to `daemon.log` for the whole life of the process, so nothing inside a running daemon can safely
 * truncate it — the only safe moment is just before a *new* daemon is spawned, while no writer
 * holds the file open. {@link rotateDaemonLogIfNeeded} is therefore called from the spawn path
 * (`rpc/client.ts`'s `defaultSpawn`, which is also what `cordierite daemon start` spawns through),
 * never from the daemon itself.
 *
 * "Nothing answered the socket" is not by itself proof that nothing is writing the log: a daemon
 * that is still booting, wedged, or mid-shutdown holds its log fd while its socket is unreachable,
 * and the spawn lock is released as soon as the child is spawned rather than when it is ready. A
 * rename under such a process would send its output to `daemon.log.1`, and the *next* rotation
 * would then unlink the inode it is still writing to — output lost, with nothing on disk to show
 * for it. So rotation additionally requires the pidfile to name a process that is gone, using the
 * same liveness probe the pidfile takeover and the stale-socket unlink use.
 *
 * One backup is enough (`daemon.log.1`): the point is a bounded footprint, not a full history. A
 * rotation failure is warned and swallowed — a daemon that cannot rotate its log must still start.
 */

import { chmod, rename, stat } from "node:fs/promises";

import { DEFAULT_DAEMON_LOG_MAX_BYTES, loadConfig } from "./config.js";
import { isProcessAlive, readPidFromFile } from "./pidfile.js";
import { getStateDirPaths } from "./state-dir.js";

/** Mode every file under the state dir is held at (ARCHITECTURE.md §3). */
const STATE_FILE_MODE = 0o600;

export const daemonLogBackupPath = (logFilePath: string): string => `${logFilePath}.1`;

export type RotateDaemonLogOptions = {
  logFilePath: string;
  /** Rotate once the log is strictly larger than this. */
  maxBytes: number;
  /** When given, an over-cap log is left alone if this pidfile names a live process — see the
   * module doc comment. Omit only when the caller has already established that nothing holds the
   * log open. */
  pidFilePath?: string;
  /** Sink for rotation-failure diagnostics; defaults to `process.stderr`. Injectable for tests. */
  warn?: (message: string) => void;
};

export type RotateDaemonLogResult = {
  rotated: boolean;
  /** Size of the log that was moved aside; only set when `rotated` is `true`. */
  rotatedBytes?: number;
  /** Why an over-cap log was deliberately left in place. */
  skipped?: "daemon_running";
};

/** True when `pidFilePath` names a process that is still around. A missing/garbage pidfile, or an
 * unreadable one, reads as "nothing is running" — the same conclusion the pidfile takeover and the
 * stale-socket unlink draw from it. */
const isDaemonHoldingLog = async (pidFilePath: string): Promise<boolean> => {
  try {
    const pid = await readPidFromFile(pidFilePath);
    return pid !== undefined && isProcessAlive(pid);
  } catch {
    return false;
  }
};

/**
 * Moves `daemon.log` to `daemon.log.1` when it exceeds `maxBytes`, replacing any previous backup.
 * A missing log, a log within the cap, a log a live daemon still holds, or any failure is a no-op
 * — never throws.
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

    // Checked only once rotation is actually on the table, so the overwhelmingly common
    // within-cap spawn stays two syscalls.
    if (options.pidFilePath !== undefined && (await isDaemonHoldingLog(options.pidFilePath))) {
      warn(
        `cordierite: "${options.logFilePath}" is over its size cap but a daemon still holds it; leaving it in place.`,
      );

      return { rotated: false, skipped: "daemon_running" };
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
