/**
 * Pidfile single-instancing (ARCHITECTURE.md §4). Acquired with `O_EXCL`; on conflict, liveness
 * is checked with `process.kill(pid, 0)` and the pidfile is only taken over if the owning
 * process is dead.
 */

import { open, readFile, rm } from "node:fs/promises";

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`Cordierite daemon is already running (pid ${pid}).`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export type PidfileHandle = {
  readonly pid: number;
  /** Idempotent: safe to call more than once. */
  release: () => Promise<void>;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we lack permission to signal it — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const readPidFromFile = async (pidFilePath: string): Promise<number | undefined> => {
  let contents: string;

  try {
    contents = await readFile(pidFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  const pid = Number.parseInt(contents.trim(), 10);

  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

export type AcquirePidfileOptions = {
  pid?: number;
  /**
   * Invoked once, after a stale (dead-owner) pidfile is detected and removed, before the pidfile
   * is re-acquired. Lets the caller clean up other stale state (e.g. `daemon.sock`) tied to the
   * dead process.
   */
  onStaleTakeover?: () => Promise<void>;
};

/**
 * Acquires the daemon pidfile, taking over a stale one (owner process is dead or the file is
 * unparseable) but throwing {@link DaemonAlreadyRunningError} when a live daemon holds it.
 */
export const acquirePidfile = async (
  pidFilePath: string,
  options: AcquirePidfileOptions = {},
): Promise<PidfileHandle> => {
  const pid = options.pid ?? process.pid;

  // Bounded retry: another process could win the takeover race between our stale-check and our
  // write attempt. A handful of retries is enough to make forward progress deterministic in tests
  // without looping forever on a persistently-contended pidfile.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = await open(pidFilePath, "wx", 0o600);

      try {
        await handle.writeFile(String(pid), "utf8");
      } finally {
        await handle.close();
      }

      let released = false;

      return {
        pid,
        release: async () => {
          if (released) {
            return;
          }

          released = true;
          await rm(pidFilePath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const existingPid = await readPidFromFile(pidFilePath);

      if (existingPid !== undefined && isProcessAlive(existingPid)) {
        throw new DaemonAlreadyRunningError(existingPid);
      }

      // Stale pidfile (dead owner, or unparseable contents): remove and retry.
      await rm(pidFilePath, { force: true });
      await options.onStaleTakeover?.();
    }
  }

  throw new Error(`Failed to acquire the Cordierite daemon pidfile at "${pidFilePath}".`);
};
