import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import {
  canClaimPendingSession,
  formatAgentWebSocketUrl,
  isToolErrorMessage,
  isToolRegistryDeltaMessage,
  isToolRegistrySnapshotMessage,
  isToolResultMessage,
  isSessionClaimMessage,
  parseSessionClaimDeviceFields,
  isValidPort,
  encodeConnectBootstrapWireBinary,
  toConnectBootstrapPayload,
  type CliResult,
  type ConnectBootstrapPayload,
  type HostCommandData,
  type PendingSessionRecord,
  type SessionClaimMessage,
  type ToolDescriptor,
  type ToolCallMessage,
} from "cordierite-shared";

import { connectionError, sessionError, toolError, usageError } from "../errors.js";
import { parseJsonObject } from "../parse.js";
import type { HostCommandContext } from "../runtime.js";
import {
  deleteSessionRegistryEntry,
  writeSessionRegistryEntry,
  type CordieriteSessionRegistryEntry,
} from "../session-registry.js";

const DEFAULT_TTL_SECONDS = 30;
const DEFAULT_PORT = 8443;
const DEFAULT_REMOTE_CALL_TIMEOUT_MS = 10_000;

type HostedCommand = {
  result: CliResult<HostCommandData>;
  completion: Promise<void>;
  stop: () => void;
};

export type HostCommandOptions = {
  tlsCert: string;
  tlsKey: string;
  ip?: string;
  port?: number;
  ttlSeconds?: number;
  scheme: string;
  open?: boolean;
};

type HostRuntimeOptions = {
  pendingSession: PendingSessionWithTokenRaw;
  keyPem: string;
  certPem: string;
  clock: HostCommandContext["clock"];
  deviceStatus?: HostCommandContext["deviceStatus"];
};

const padBase64Url = (value: string): string => {
  return value.replaceAll("+", "-").replaceAll("/", "_").replaceAll(/=+$/gu, "");
};

const encodeBootstrapPayload = (
  payload: ConnectBootstrapPayload,
  tokenRaw?: Uint8Array,
): string => {
  const wire = encodeConnectBootstrapWireBinary(payload, tokenRaw);

  return padBase64Url(Buffer.from(wire).toString("base64"));
};

const randomId = (size = 16): string => {
  return padBase64Url(Buffer.from(randomBytes(size)).toString("base64"));
};

const detectHostIp = (): string => {
  const interfaces = networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }

      if (
        entry.address.startsWith("10.") ||
        entry.address.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./u.test(entry.address)
      ) {
        return entry.address;
      }
    }
  }

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  throw connectionError("Could not determine a local IPv4 address for the Cordierite host.");
};

export const getSpkiPinFromCertificate = (certificatePem: string): string => {
  const certificate = new X509Certificate(certificatePem);
  const spkiDer = certificate.publicKey.export({
    type: "spki",
    format: "der",
  });
  const digest = createHash("sha256").update(spkiDer).digest("base64");

  return `sha256/${digest}`;
};

export type PendingSessionWithTokenRaw = PendingSessionRecord & { tokenRaw: Uint8Array };

export const createPendingSession = (
  endpoint: { ip: string; port: number },
  nowUnixSeconds: number,
  ttlSeconds: number,
): PendingSessionWithTokenRaw => {
  const tokenRaw = new Uint8Array(randomBytes(32));

  return {
    session_id: Buffer.from(randomBytes(12)).toString("base64url"),
    token: padBase64Url(Buffer.from(tokenRaw).toString("base64")),
    tokenRaw,
    ip: endpoint.ip,
    port: endpoint.port,
    expires_at: nowUnixSeconds + ttlSeconds,
    status: "pending",
  };
};

export const createBootstrapDeepLink = (
  payload: ConnectBootstrapPayload,
  scheme: string,
  tokenRaw?: Uint8Array,
): string => {
  return `${scheme}:///?cordierite=${encodeBootstrapPayload(payload, tokenRaw)}`;
};

const sendToolCall = (
  websocket: WebSocket,
  sessionId: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
) => {
  const message: ToolCallMessage = {
    type: "tool_call",
    session_id: sessionId,
    id,
    name,
    args,
  };

  websocket.send(JSON.stringify(message));
};

type StartHostRuntimeResult = {
  completion: HostedCommand["completion"] & { stop: () => void };
  controlPort: number;
};

const startHostRuntime = async (options: HostRuntimeOptions): Promise<StartHostRuntimeResult> => {
  const { deviceStatus } = options;
  let claimed = false;
  let activeSocket: WebSocket | null = null;
  let stopped = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  let completionSettled = false;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  const sessionRegisteredAt = new Date(options.clock.now()).toISOString();
  const remoteRegistry = new Map<string, ToolDescriptor>();
  const pendingCalls = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  const settleCompletion = (error?: unknown) => {
    if (completionSettled) {
      return;
    }

    completionSettled = true;

    if (error === undefined) {
      resolveCompletion();
      return;
    }

    rejectCompletion(error);
  };

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  }) as HostedCommand["completion"] & { stop: () => void };

  const httpsServer = createHttpsServer({
    key: options.keyPem,
    cert: options.certPem,
  });
  const websocketServer = new WebSocketServer({
    noServer: true,
  });
  const controlServer = createHttpServer(async (request, response) => {
    const sendJson = (statusCode: number, payload: unknown) => {
      response.writeHead(statusCode, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(payload));
    };

    if (request.method === "GET" && request.url === "/tools") {
      sendJson(200, {
        ok: true,
        data: {
          tools: Array.from(remoteRegistry.values()),
        },
      });
      return;
    }

    if (request.method === "GET" && request.url === "/session") {
      sendJson(200, {
        ok: true,
        data: claimed && activeSocket
          ? {
              status: "active",
              session_id: options.pendingSession.session_id,
              endpoint: {
                ip: options.pendingSession.ip,
                port: options.pendingSession.port,
                url: formatAgentWebSocketUrl(options.pendingSession),
              },
            }
          : {
              status: "none",
            },
      });
      return;
    }

    if (request.method === "POST" && request.url === "/call") {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        rawBody += chunk;
      });
      request.on("end", async () => {
        try {
          const parsed = parseJsonObject(rawBody || "{}", "request body");
          const name = parsed.name;
          const args: Record<string, unknown> =
            typeof parsed.args === "object" && parsed.args !== null && !Array.isArray(parsed.args)
              ? (parsed.args as Record<string, unknown>)
              : {};

          if (typeof name !== "string" || name.length === 0) {
            throw usageError("Remote call requires a tool name.");
          }

          if (!claimed || !activeSocket) {
            throw connectionError("No active Cordierite app session is connected.");
          }

          const connectedSocket = activeSocket;

          if (!remoteRegistry.has(name)) {
            throw toolError(`Remote tool "${name}" is not registered in the connected app.`, {
              type: "tool_not_found",
            });
          }

          const invocationId = `call_${randomId(8)}`;
          const result = await new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingCalls.delete(invocationId);
              reject(
                toolError(`Remote tool "${name}" timed out.`, {
                  type: "tool_timeout",
                }),
              );
            }, DEFAULT_REMOTE_CALL_TIMEOUT_MS);

            pendingCalls.set(invocationId, {
              resolve,
              reject,
              timeout,
            });
            sendToolCall(connectedSocket, options.pendingSession.session_id, invocationId, name, args);
          });

          sendJson(200, {
            ok: true,
            data: {
              tool: name,
              result,
            },
          });
        } catch (error) {
          const typedError =
            error instanceof Error && "type" in error
              ? {
                type: String((error as { type?: unknown }).type),
                message: error.message,
                details: "details" in error ? (error as { details?: unknown }).details : undefined,
              }
              : error instanceof Error
                ? {
                  type: "tool_error",
                  message: error.message,
                }
                : {
                  type: "tool_error",
                  message: String(error),
                };

          sendJson(400, {
            ok: false,
            error: typedError,
          });
        }
      });
      return;
    }

    sendJson(404, {
      ok: false,
      error: {
        type: "connection_error",
        message: "Unknown host control route.",
      },
    });
  });

  const persistState = async () => {
    const address = controlServer.address();

    if (!address || typeof address === "string") {
      return;
    }

    const nowIso = new Date(options.clock.now()).toISOString();
    const entry: CordieriteSessionRegistryEntry = {
      sessionId: options.pendingSession.session_id,
      controlPort: address.port,
      wssPort: options.pendingSession.port,
      ip: options.pendingSession.ip,
      pid: process.pid,
      registeredAt: sessionRegisteredAt,
      lastSeenAt: nowIso,
      status: options.pendingSession.status === "active" ? "active" : "pending",
      endpoint: {
        ip: options.pendingSession.ip,
        port: options.pendingSession.port,
        url: formatAgentWebSocketUrl(options.pendingSession),
      },
      remoteTools: Array.from(remoteRegistry.values()),
    };

    await writeSessionRegistryEntry(entry);
  };

  const clearRuntimeState = async () => {
    remoteRegistry.clear();
    for (const pending of pendingCalls.values()) {
      clearTimeout(pending.timeout);
      pending.reject(connectionError("Cordierite app session disconnected before replying."));
    }
    pendingCalls.clear();

    await deleteSessionRegistryEntry(options.pendingSession.session_id);
  };

  const clearTtlTimer = () => {
    if (ttlTimer !== null) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
  };

  httpsServer.on("request", (_request, response) => {
    response.writeHead(404);
    response.end("Not found");
  });

  websocketServer.on("connection", (websocket) => {
    if (activeSocket && activeSocket !== websocket) {
      websocket.close(1008, "single_session_only");
      return;
    }

    activeSocket = websocket;

    websocket.on("message", (message) => {
      const text =
        typeof message === "string"
          ? message
          : Buffer.isBuffer(message)
            ? message.toString("utf8")
            : Array.isArray(message)
              ? Buffer.concat(message).toString("utf8")
              : Buffer.from(message).toString("utf8");
      let parsed: unknown;

      try {
        parsed = JSON.parse(text);
      } catch {
        websocket.close(1008, "invalid_json");
        return;
      }

      if (!claimed) {
        if (!isSessionClaimMessage(parsed)) {
          websocket.close(1008, "expected_session_claim");
          return;
        }

        const claim = parsed as SessionClaimMessage;
        const claimable = canClaimPendingSession(options.pendingSession);

        if (
          !claimable ||
          claimed ||
          claim.session_id !== options.pendingSession.session_id ||
          claim.token !== options.pendingSession.token
        ) {
          websocket.close(1008, "invalid_session_claim");
          return;
        }

        claimed = true;
        clearTtlTimer();
        options.pendingSession.status = "active";
        websocket.send(
          JSON.stringify({
            type: "session_ack",
            session_id: options.pendingSession.session_id,
            status: "ok",
          }),
        );
        const deviceInfo = parseSessionClaimDeviceFields(claim as unknown as Record<string, unknown>);
        deviceStatus?.onClaimed(deviceInfo === "invalid" ? undefined : deviceInfo);
        void persistState();
        return;
      }

      if (isToolRegistrySnapshotMessage(parsed)) {
        remoteRegistry.clear();
        for (const tool of parsed.tools) {
          remoteRegistry.set(tool.name, tool);
        }
        void persistState();
        return;
      }

      if (isToolRegistryDeltaMessage(parsed)) {
        if (parsed.operation === "upsert" && parsed.tool) {
          remoteRegistry.set(parsed.tool.name, parsed.tool);
        } else if (parsed.operation === "remove" && parsed.name) {
          remoteRegistry.delete(parsed.name);
        }
        void persistState();
        return;
      }

      if (isToolResultMessage(parsed)) {
        const pending = pendingCalls.get(parsed.id);

        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        pendingCalls.delete(parsed.id);
        pending.resolve(parsed.result);
        return;
      }

      if (isToolErrorMessage(parsed)) {
        const pending = pendingCalls.get(parsed.id);

        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        pendingCalls.delete(parsed.id);
        pending.reject(
          toolError(parsed.error.message, {
            type: parsed.error.type,
            details: parsed.error.details,
          }),
        );
        return;
      }
    });

    websocket.on("close", () => {
      if (activeSocket === websocket) {
        const hadClaimedSession = claimed;
        activeSocket = null;
        if (hadClaimedSession) {
          deviceStatus?.onClaimedSessionEnded();
        }
        void stopServer();
      }
    });
  });

  httpsServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`);

    if (url.pathname !== "/") {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  const dropOpenSockets = (server: ReturnType<typeof createHttpServer>) => {
    const withForceClose = server as typeof server & { closeAllConnections?: () => void };
    withForceClose.closeAllConnections?.();
  };

  const closeServer = async (
    server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>,
  ) => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (
          error &&
          !(typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
        ) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  };

  const stopServer = async (error?: unknown) => {
    if (stopped) {
      return;
    }

    stopped = true;
    clearTtlTimer();
    if (activeSocket) {
      // Never removeAllListeners() on the socket: ws uses a "close" listener to update clients (noServer).
      activeSocket.close(1000, "host_stopped");
      activeSocket = null;
    }

    try {
      await clearRuntimeState();
      await new Promise<void>((resolve, reject) => {
        websocketServer.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      dropOpenSockets(controlServer);
      await closeServer(controlServer);
      dropOpenSockets(httpsServer);
      await closeServer(httpsServer);
    } finally {
      settleCompletion(error);
    }
  };

  let controlPort = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpsServer.off("error", onError);
        const wrapped =
          err.code === "EADDRINUSE"
            ? connectionError(
                `Port ${options.pendingSession.port} is already in use. Choose a different --port.`,
                { port: options.pendingSession.port, code: err.code },
              )
            : err;
        reject(wrapped);
      };
      httpsServer.once("error", onError);
      httpsServer.once("listening", () => {
        httpsServer.off("error", onError);
        resolve();
      });
      httpsServer.listen(options.pendingSession.port);
    });

    controlPort = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        controlServer.off("error", onError);
        reject(err);
      };
      controlServer.once("error", onError);
      controlServer.once("listening", () => {
        controlServer.off("error", onError);
        const addr = controlServer.address();
        if (!addr || typeof addr === "string") {
          reject(connectionError("Cordierite host control server failed to bind."));
          return;
        }
        resolve(addr.port);
      });
      controlServer.listen(0, "127.0.0.1");
    });

    ttlTimer = setTimeout(() => {
      if (claimed) {
        return;
      }

      void stopServer(sessionError("Pending session TTL expired before any app connected."));
    }, Math.max(0, options.pendingSession.expires_at * 1000 - options.clock.now().getTime()));

    deviceStatus?.onListening();
    void persistState();
  } catch (error) {
    clearTtlTimer();
    dropOpenSockets(controlServer);
    await closeServer(controlServer).catch(() => {});
    dropOpenSockets(httpsServer);
    await closeServer(httpsServer).catch(() => {});
    settleCompletion(error);
    throw error;
  }

  completion.stop = () => {
    void stopServer();
  };

  return { completion, controlPort };
};

const openDeepLink = async (deepLink: string): Promise<void> => {
  const command = spawn("xcrun", ["simctl", "openurl", "booted", deepLink], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderrChunks: Buffer[] = [];

  command.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    command.on("error", reject);
    command.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw connectionError("Failed to open the Cordierite deep link in the booted simulator.", {
      exit_code: exitCode,
      stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
    });
  }
};

export const handleHostCommand = async (
  options: HostCommandOptions,
  context: HostCommandContext,
): Promise<HostedCommand> => {
  if (!options.tlsCert) {
    throw usageError("The host command requires --tls-cert.");
  }

  if (!options.tlsKey) {
    throw usageError("The host command requires --tls-key.");
  }

  if (!options.scheme) {
    throw usageError("The host command requires --scheme.");
  }

  const port = options.port ?? DEFAULT_PORT;

  if (!isValidPort(port)) {
    throw usageError("The host command requires a valid --port.");
  }

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw usageError("The host command requires a positive --ttl value.");
  }

  const [certPem, keyPem] = await Promise.all([
    readFile(options.tlsCert, "utf8"),
    readFile(options.tlsKey, "utf8"),
  ]);

  if (certPem.length === 0 || keyPem.length === 0) {
    throw connectionError("TLS certificate and key files must be readable and non-empty.");
  }

  const nowUnixSeconds = Math.floor(context.clock.now().getTime() / 1000);
  const ip = options.ip ?? detectHostIp();
  const pendingSession = createPendingSession(
    {
      ip,
      port,
    },
    nowUnixSeconds,
    ttlSeconds,
  );
  const bootstrapPayload = toConnectBootstrapPayload(pendingSession);
  const appScheme = options.scheme;
  const deepLink = createBootstrapDeepLink(bootstrapPayload, appScheme, pendingSession.tokenRaw);
  const spkiPin = getSpkiPinFromCertificate(certPem);
  const { completion, controlPort } = await startHostRuntime({
    pendingSession,
    certPem,
    keyPem,
    clock: context.clock,
    deviceStatus: context.deviceStatus,
  });

  if (options.open) {
    await openDeepLink(deepLink);
  }

  return {
    result: {
      ok: true,
      data: {
        host: {
          deep_link: deepLink,
          ttl_seconds: ttlSeconds,
          spki_pin: spkiPin,
          session_id: pendingSession.session_id,
          wss_port: port,
          control_port: controlPort,
        },
      },
    },
    completion,
    stop: completion.stop,
  };
};
