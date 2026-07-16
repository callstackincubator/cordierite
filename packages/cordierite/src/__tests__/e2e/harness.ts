/**
 * Task 16: shared harness for the end-to-end suite. Consolidates the patterns already proven in
 * this package's other integration tests rather than inventing a third one:
 *
 * - the real-CLI-subprocess pattern from `cli-v2.integration.test.ts` / `exit-codes.integration.test.ts`
 *   (`runCliJson`, temp state dirs, daemon-pid tracking for teardown);
 * - the raw-UDS-RPC event-subscription pattern from `session-engine.integration.test.ts` /
 *   `tool-invocation.integration.test.ts` (`waitForEvent`), used here purely for *test
 *   synchronization* (never to drive the scenario itself — every scenario action goes through a
 *   real CLI subprocess or the fake app client's WebSocket, per the task's "not imported" rule).
 *
 * Every e2e test file is expected to import {@link cleanupAfterEach} and call it from its own
 * top-level `afterEach` (test hooks are file-scoped).
 */

import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as connectUds, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { connect as tlsConnect } from "node:tls";

import { decodeBootstrap, type EventKind, type EventNotification } from "@cordierite/shared";

import { getStateDirPaths } from "../../daemon/state-dir.js";
import { binEntry, packageRoot, spawnCliBinary, waitForExit, writeTestHostKey } from "../fixtures.js";

export { binEntry, packageRoot, writeTestHostKey };
export { waitForExit } from "../fixtures.js";

// This suite uses throwaway self-signed certificates, so built-in TLS verification is disabled
// process-wide. It does not rely on
// that verification for its pinning guarantee: `FakeAppClient` (app-client.ts) independently
// verifies the daemon's SPKI pin over a raw `tls` socket (`verifyServerPin` below) before ever
// trusting the `ws` connection used for the wire protocol — that is the real trust decision an app
// SDK makes.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const stateDirs: string[] = [];
const daemonPids: number[] = [];
const extraCleanups: Array<() => void | Promise<void>> = [];

export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Call from every e2e test file's own top-level `afterEach` (test hooks are per-file). */
export const cleanupAfterEach = async (): Promise<void> => {
  while (extraCleanups.length > 0) {
    await extraCleanups.pop()?.();
  }

  while (daemonPids.length > 0) {
    const pid = daemonPids.pop()!;
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  while (stateDirs.length > 0) {
    await rm(stateDirs.pop()!, { force: true, recursive: true });
  }
};

export const trackDaemonPid = (pid: number): void => {
  daemonPids.push(pid);
};

/** Removes `pid` from the tracked set — used when a test deliberately kills a daemon itself
 * (daemon-restart.e2e.test.ts) and wants a later `ensureDaemon` in the same test to track the
 * *new* pid instead of double-killing the old one during teardown. */
export const untrackDaemonPid = (pid: number): void => {
  const index = daemonPids.indexOf(pid);

  if (index !== -1) {
    daemonPids.splice(index, 1);
  }
};

export const trackCleanup = (fn: () => void | Promise<void>): void => {
  extraCleanups.push(fn);
};

export const pickFreePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
};

export type TestStateDir = {
  stateDir: string;
  port: number;
};

/** Always pins a free port and a throwaway host key: every e2e scenario runs several concurrent
 * test files, each with its own real daemon subprocess/listener. */
export const makeTempStateDir = async (configOverrides: Record<string, unknown> = {}): Promise<TestStateDir> => {
  const directory = await mkdtemp(path.join(tmpdir(), "cordierite-e2e-"));
  await writeTestHostKey(path.join(directory, "key.pem"));

  const port = await pickFreePort();
  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1", scheme: "cordierite-e2e", ...configOverrides }),
  );

  stateDirs.push(directory);
  return { stateDir: directory, port };
};

export type CliJsonResult<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: { type: string; message: string; details?: unknown };
  exitCode: number;
};

/**
 * Runs the built Node CLI as a real subprocess and parses its `--json`
 * stdout — task 16 scope: "built CLI invoked as a subprocess — not imported — so argv parsing, exit
 * codes, and auto-spawn are covered for real. It uses an async process because
 * several scenarios need the daemon to round-trip through this test's own fake app WebSocket client
 * while the CLI subprocess is in flight, and a sync spawn would block this process's event loop for
 * the subprocess's entire lifetime, deadlocking that round-trip (see `cli-v2.integration.test.ts`).
 */
export const runCliJson = async <T = unknown>(args: string[], stateDir: string): Promise<CliJsonResult<T>> => {
  const proc = spawnCliBinary([...args, "--json"], { stateDir });

  const [stdout, stderr] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
  ]);
  const exitCode = await waitForExit(proc);

  try {
    return { ...(JSON.parse(stdout) as CliJsonResult<T>), exitCode };
  } catch (error) {
    throw new Error(
      `Failed to parse CLI JSON output for [${args.join(" ")}] (exit ${exitCode}): ${(error as Error).message}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
};

/** Spawns the CLI without waiting for exit — for long-running subcommands (`events`, `daemon run`). */
export const spawnCli = (args: string[], stateDir: string, extraEnv: Record<string, string> = {}) => {
  return spawnCliBinary(args, { stateDir, extraEnv });
};

/** Ensures a daemon is up for `stateDir` (auto-spawns via `daemon status`), returning its pid
 * tracked for teardown. */
export const ensureDaemon = async (stateDir: string): Promise<number> => {
  const status = await runCliJson<{ daemon: { pid: number } }>(["daemon", "status"], stateDir);

  if (!status.ok || !status.data) {
    throw new Error(`Failed to bring up a daemon for "${stateDir}": ${JSON.stringify(status)}`);
  }

  const pid = status.data.daemon.pid;
  trackDaemonPid(pid);
  return pid;
};

/** Fetches the daemon's advertised SPKI pin-set via a real `daemon status --json` CLI call. */
export const fetchPinnedKeys = async (stateDir: string): Promise<string[]> => {
  const status = await runCliJson<{ daemon: { pinned_keys: string[] } }>(["daemon", "status"], stateDir);

  if (!status.ok || !status.data) {
    throw new Error(`Failed to read daemon status for "${stateDir}": ${JSON.stringify(status)}`);
  }

  return status.data.daemon.pinned_keys;
};

export type DecodedLink = { sessionId: string; token: string; port: number };

/** Extracts the deep-link payload and decodes it into a claimable link. */
export const decodeDeepLink = (deepLink: string): DecodedLink => {
  const marker = "cordierite=";
  const payload = deepLink.slice(deepLink.indexOf(marker) + marker.length);
  const decoded = decodeBootstrap(payload);

  if (!decoded) {
    throw new Error(`Failed to decode bootstrap payload from deep link "${deepLink}".`);
  }

  return { sessionId: decoded.sessionId, token: decoded.token, port: decoded.port };
};

/** Mints a link through a real `cordierite link` CLI subprocess and decodes it. */
export const mintLink = async (
  stateDir: string,
  options: { ttlSeconds?: number } = {},
): Promise<DecodedLink> => {
  const args = ["link"];

  if (options.ttlSeconds !== undefined) {
    args.push("--ttl", String(options.ttlSeconds));
  }

  const result = await runCliJson<{ deepLink: string }>(args, stateDir);

  if (!result.ok || !result.data) {
    throw new Error(`"link" failed: ${JSON.stringify(result)}`);
  }

  return decodeDeepLink(result.data.deepLink);
};

// ---------------------------------------------------------------------------------------------
// SPKI pin verification (task 16 scope item 1)
// ---------------------------------------------------------------------------------------------

/** Mirrors `spki-pin.ts`'s pin format, computed from a leaf certificate's DER bytes instead of a
 * private key — the same value, since the daemon signs its own leaf with its host key. */
export const computeSpkiPinFromCertDer = (certDer: Buffer): string => {
  const cert = new X509Certificate(certDer);
  const spkiDer = cert.publicKey.export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(spkiDer).digest("base64");
  return `sha256/${digest}`;
};

/**
 * Opens a raw TLS socket to the daemon's wss port and verifies its leaf certificate hashes to one
 * of `expectedPins` — the actual trust decision a real app SDK makes (ARCHITECTURE.md: "Apps
 * authenticate the host via SPKI pin-sets over `wss://`"). Rejects on mismatch or on no
 * certificate at all. Kept as a standalone TLS connection (rather than piggy-backing on the `ws`
 * client used for the protocol) to keep this pin verification independent from the protocol
 * connection.
 */
export const verifyServerPin = (port: number, expectedPins: readonly string[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      try {
        // The detailed form provides the DER certificate bytes needed for pin verification.
        const peerCert = socket.getPeerCertificate(true);

        if (!peerCert || !peerCert.raw) {
          throw new Error("Daemon presented no peer certificate during pin verification.");
        }

        const pin = computeSpkiPinFromCertDer(peerCert.raw);

        if (!expectedPins.includes(pin)) {
          throw new Error(
            `SPKI pin mismatch: daemon presented "${pin}", expected one of [${expectedPins.join(", ")}].`,
          );
        }

        resolve();
      } catch (error) {
        reject(error as Error);
      } finally {
        socket.end();
      }
    });

    socket.once("error", reject);
  });
};

// ---------------------------------------------------------------------------------------------
// Raw UDS event subscription — synchronization only (never drives scenario behavior)
// ---------------------------------------------------------------------------------------------

/** Opens a persistent raw UDS RPC connection and subscribes to `events.subscribe`, exposing a
 * `waitFor` helper that resolves the next occurrence of a given `EventKind`. Used purely to
 * deterministically synchronize test assertions with daemon-internal transitions (grace expiry,
 * tool-call completion, ...) without sleeping — every actual scenario action still goes through
 * the real CLI subprocess or the fake app client. */
/**
 * Polls `check` until it resolves truthy or `timeoutMs` elapses (then throws). Unlike a bare
 * `setTimeout` wait, this never trusts a fixed duration — it re-checks the actual condition on a
 * short interval and returns the moment it holds, with the timeout acting only as a safety net
 * (the same shape as `rpc/client.ts`'s own `pollForSocket`, used here for conditions that module
 * doesn't cover, e.g. "this file no longer exists").
 */
export const waitUntil = async (
  check: () => Promise<boolean> | boolean,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (await check()) {
    return;
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${options.description ?? "condition"}.`);
};

export type EventWaiter = {
  waitFor: (kind: EventKind, predicate?: (event: EventNotification) => boolean) => Promise<EventNotification>;
  close: () => void;
};

export const subscribeToEvents = (stateDir: string): Promise<EventWaiter> => {
  const paths = getStateDirPaths(stateDir);

  return new Promise((resolve, reject) => {
    const socket: Socket = connectUds(paths.socketPath);
    let buffer = "";
    let nextId = 1;
    const waiters: Array<{
      kind: EventKind;
      predicate?: (event: EventNotification) => boolean;
      resolve: (event: EventNotification) => void;
    }> = [];
    const backlog: EventNotification[] = [];

    const dispatch = (event: EventNotification): void => {
      const index = waiters.findIndex(
        (waiter) => waiter.kind === event.kind && (!waiter.predicate || waiter.predicate(event)),
      );

      if (index === -1) {
        backlog.push(event);
        return;
      }

      const [waiter] = waiters.splice(index, 1);
      waiter!.resolve(event);
    };

    socket.once("connect", () => {
      socket.off("error", onConnectError);
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: nextId, method: "events.subscribe", params: {} })}\n`,
      );
      nextId += 1;

      resolve({
        waitFor: (kind, predicate) => {
          // A matching event may already have arrived before `waitFor` was called.
          const backlogIndex = backlog.findIndex(
            (event) => event.kind === kind && (!predicate || predicate(event)),
          );

          if (backlogIndex !== -1) {
            const [event] = backlog.splice(backlogIndex, 1);
            return Promise.resolve(event!);
          }

          return new Promise((resolveWaiter) => {
            waiters.push({ kind, predicate, resolve: resolveWaiter });
          });
        },
        close: () => socket.destroy(),
      });
    });

    const onConnectError = (error: Error): void => reject(error);
    socket.once("error", onConnectError);

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (line.length === 0) {
          continue;
        }

        let message: { method?: string; params?: unknown };

        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.method === "event") {
          dispatch(message.params as EventNotification);
        }
      }
    });
  });
};
