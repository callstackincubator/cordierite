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
 * for it. So rotation asks twice, as late as it can, and declines on either answer:
 *
 * - the pidfile must not name a live process (the same probe the pidfile takeover and the
 *   stale-socket unlink use); and
 * - `daemon.sock` must not accept a connection, re-checked immediately before the rename.
 *
 * **This narrows the window; it does not close it.** A daemon spawned microseconds ago holds its
 * log fd before it has written `daemon.pid` or bound its socket, and no check performed before the
 * rename can see it — the file it is writing to is simply not distinguishable, from the outside,
 * from one nobody holds. What is left is a race measured in the milliseconds between a child being
 * spawned and it writing its pidfile, entered only by a *second* spawner that also finds the log
 * over its cap. The consequence is bounded (that daemon's output continues into `daemon.log.1`,
 * and is lost if a later rotation replaces that backup), and a just-spawned daemon's log is far
 * below any sane cap, so in practice the second spawner does not rotate at all. Closing it
 * properly needs an advisory lock held across spawn-and-ready rather than released at spawn.
 *
 * One backup is enough (`daemon.log.1`): the point is a bounded footprint, not a full history. A
 * rotation failure is warned and swallowed — a daemon that cannot rotate its log must still start.
 */

import { chmod, rename, stat } from "node:fs/promises";

import { DEFAULT_DAEMON_LOG_MAX_BYTES, loadConfig } from "./config.js";
import { isProcessAlive, readPidFromFile } from "./pidfile.js";
import { isSocketConnectable } from "./socket-probe.js";
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
  /** When given, an over-cap log is left alone if this control socket accepts a connection,
   * re-checked immediately before the rename. Catches a daemon that is up but was unreachable
   * when the caller decided to spawn. */
  socketPath?: string;
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

    // Both checks run only once rotation is actually on the table, so the overwhelmingly common
    // within-cap spawn stays two syscalls — and as late as possible, to keep the window in which
    // a daemon can appear between the check and the rename as small as it can be made.
    const held =
      (options.pidFilePath !== undefined && (await isDaemonHoldingLog(options.pidFilePath))) ||
      (options.socketPath !== undefined && (await isSocketConnectable(options.socketPath)));

    if (held) {
      warn(
        `cordierite: "${options.logFilePath}" is over its size cap but a daemon still holds it; leaving it in place.`,
      );

      return { rotated: false, skipped: "daemon_running" };
    }

    const backupPath = daemonLogBackupPath(options.logFilePath);
    // `rename` is atomic within the state dir, so a concurrent spawner either sees the old log or
    // the rotated one — never a half-copied file.
    await rename(options.logFilePath, backupPath);

    // Deliberately its own try/catch, *after* the rename has already succeeded. `rename` preserves
    // the log's mode, so this only ever repairs a backup that predates this code (or an operator's
    // `cp`) — and a filesystem that refuses the chmod must not make a completed rotation report
    // itself as "not rotated" under a warning naming the wrong step.
    try {
      await chmod(backupPath, STATE_FILE_MODE);
    } catch (error) {
      warn(`cordierite: rotated "${options.logFilePath}" but could not set 0600 on "${backupPath}": ${(error as Error).message}`);
    }

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
 * Best-effort enforcement of `daemon.log`'s ARCHITECTURE.md §3 mode. `open(path, "a", 0o600)`
 * already creates it at `0600` (the umask can only remove bits), so this exists for the file that
 * was *not* created by us — an operator's `touch`, a `cp` from elsewhere — and is a no-op
 * otherwise.
 *
 * Never throws. It sits directly on the auto-spawn path, where every CLI and MCP command that
 * needs a daemon passes through: a filesystem that answers `chmod` with EPERM or ENOTSUP (a
 * drvfs/NFS/SMB-backed state dir, a root-owned log under a non-root user) would otherwise brick
 * every one of those commands over a permission bit. A daemon that cannot tighten its log mode
 * must still start — loudly, but it must start.
 */
export const ensureDaemonLogMode = async (
  logFilePath: string,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<boolean> => {
  try {
    await chmod(logFilePath, STATE_FILE_MODE);
    return true;
  } catch (error) {
    warn(`cordierite: could not set 0600 on "${logFilePath}": ${(error as Error).message}`);
    return false;
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
