/**
 * The pinned-TLS WebSocket listener (ARCHITECTURE.md §7). A thin frame-level gate in front of
 * `SessionManager`: JSON/binary/size hygiene, the pre-claim timeout, and post-claim
 * type/session-id routing. All state-machine decisions (claim/resume/registry/close-code choice)
 * live in sessions.ts — this module never inspects session state itself.
 *
 * Every socket gets an `error` listener the instant it is accepted, and the server itself gets one
 * too: v1's fatal defect was an unhandled `'error'` event crashing the whole daemon. A socket
 * closing — for any reason — must never stop the listener or any other session.
 */

import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";

import { isSessionClaimMessage, isSessionResumeMessage, isSessionBoundMessage } from "@cordierite/shared";
import { WebSocketServer } from "ws";

import { isPostClaimMessageType, type SessionManager } from "./sessions.js";
import type { TlsManager } from "./tls.js";
import { systemTimers, type TimerFns } from "./timers.js";

const DEFAULT_PRE_CLAIM_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;

export type ListenerOptions = {
  port: number;
  tls: TlsManager;
  sessionManager: SessionManager;
  preClaimTimeoutMs?: number;
  timers?: TimerFns;
};

export type DaemonListener = {
  httpsServer: HttpsServer;
  wss: WebSocketServer;
  port: () => number | undefined;
  close: () => Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const startListener = async (options: ListenerOptions): Promise<DaemonListener> => {
  const timers = options.timers ?? systemTimers;
  const preClaimTimeoutMs = options.preClaimTimeoutMs ?? DEFAULT_PRE_CLAIM_TIMEOUT_MS;
  const material = options.tls.current();

  const httpsServer = createHttpsServer({ key: material.keyPem, cert: material.certPem });

  httpsServer.on("error", () => {
    // A listener-level error (e.g. a transient accept failure) must never crash the daemon.
    // Startup failures are still surfaced via the one-shot listener below.
  });

  const wss = new WebSocketServer({ server: httpsServer, maxPayload: MAX_PAYLOAD_BYTES });

  wss.on("error", () => {
    // Same contract as the https server: never let a listener-level error take the daemon down.
  });

  wss.on("connection", (socket) => {
    socket.on("error", () => {
      // The 'close' event still fires after 'error' and drives session suspend/cleanup.
    });

    let claimedSessionId: string | null = null;

    const preClaimTimer = timers.setTimeout(() => {
      if (!claimedSessionId) {
        socket.close(1008, "pre_claim_timeout");
      }
    }, preClaimTimeoutMs);

    socket.once("close", () => {
      timers.clearTimeout(preClaimTimer);
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "binary_frame_not_supported");
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        socket.close(1008, "invalid_json");
        return;
      }

      if (!isRecord(parsed)) {
        socket.close(1008, "invalid_json");
        return;
      }

      if (claimedSessionId === null) {
        if (isSessionClaimMessage(parsed)) {
          const result = options.sessionManager.handleClaim(socket, parsed);

          if (result) {
            claimedSessionId = result;
            timers.clearTimeout(preClaimTimer);
          }

          return;
        }

        if (isSessionResumeMessage(parsed)) {
          const result = options.sessionManager.handleResume(socket, parsed);

          if (result) {
            claimedSessionId = result;
            timers.clearTimeout(preClaimTimer);
          }

          return;
        }

        socket.close(1008, "expected_claim_or_resume");
        return;
      }

      if (!isPostClaimMessageType(parsed.type)) {
        socket.close(1008, "unknown_message_type");
        return;
      }

      if (!isSessionBoundMessage(parsed) || parsed.session_id !== claimedSessionId) {
        socket.close(1008, "session_mismatch");
        return;
      }

      options.sessionManager.handlePostClaimMessage(claimedSessionId, socket, parsed);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpsServer.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpsServer.off("error", onError);
      resolve();
    };

    httpsServer.once("error", onError);
    httpsServer.once("listening", onListening);
    httpsServer.listen(options.port);
  });

  return {
    httpsServer,
    wss,
    port: () => {
      const address = httpsServer.address();
      return address && typeof address !== "string" ? address.port : undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }

        wss.close(() => {
          // `server.close()` alone only stops accepting new connections — it waits for existing
          // (including idle keep-alive) sockets to end, which could hang shutdown indefinitely.
          httpsServer.closeAllConnections();
          httpsServer.close(() => resolve());
        });
      }),
  };
};
