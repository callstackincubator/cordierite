/**
 * The control-plane UDS JSON-RPC server (ARCHITECTURE.md §5). Framing: one JSON-RPC 2.0 message
 * per line (`\n`-delimited). Server→client notifications use method `"event"` and are pushed via
 * {@link notify} on a targeted connection — this module only exposes the primitive.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmod, rm } from "node:fs/promises";

import type { ErrorType } from "@cordierite/shared";

/** 1 MiB — lines beyond this are dropped by destroying the connection (ARCHITECTURE.md task notes). */
export const MAX_LINE_BYTES = 1024 * 1024;

/** 4 MiB — a subscriber connection (`events.subscribe`) whose outbound buffer grows past this
 * (slow/dead reader) is dropped outright rather than left to back up the daemon indefinitely. */
export const MAX_NOTIFY_BUFFERED_BYTES = 4 * 1024 * 1024;

export class RpcApplicationError extends Error {
  constructor(
    readonly type: ErrorType,
    message: string,
    /** JSON-RPC error code; defaults to the shared "server error" range. */
    readonly code = -32000,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RpcApplicationError";
  }
}

export type RpcConnection = {
  readonly id: number;
  readonly socket: Socket;
  /** Extensibility bag for future wiring (e.g. `events.subscribe` state). */
  readonly state: Record<string, unknown>;
};

export type RpcHandlerContext = {
  connection: RpcConnection;
  /** Registers a callback to run once the in-flight response has been flushed to the socket. */
  afterSend: (callback: () => void) => void;
  /** Registers a callback to run once this connection closes — e.g. auto-cancelling a `tools.call`
   * still in flight when the connection that issued it drops. Callbacks run at most once. Returns
   * an unregister function — callers whose call already settled must use it, or the callback (and
   * whatever it closed over) leaks for the lifetime of a long-lived connection (e.g. the MCP
   * server's persistent stream, which issues many `tools.call`s over one connection). */
  onClose: (callback: () => void) => () => void;
};

export type RpcHandler = (params: unknown, context: RpcHandlerContext) => unknown | Promise<unknown>;

export type RpcDispatchTable = Record<string, RpcHandler>;

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const hasRequestId = (value: JsonRpcRequest): value is JsonRpcRequest & { id: string | number | null } => {
  return "id" in value;
};

const writeErrorLine = (
  socket: Socket,
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void => {
  writeLine(socket, {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  });
};

const writeLine = (socket: Socket, payload: unknown, onFlushed?: () => void): void => {
  if (socket.destroyed) {
    return;
  }

  socket.write(`${JSON.stringify(payload)}\n`, (error) => {
    if (!error) {
      onFlushed?.();
    }
  });
};

export type RpcServerOptions = {
  socketPath: string;
  dispatch: RpcDispatchTable;
  maxLineBytes?: number;
};

export type RpcServer = {
  server: Server;
  /** Pushes a server→client `"event"` notification (no `id`) on the given connection. */
  notify: (connection: RpcConnection, payload: unknown) => void;
  connections: () => RpcConnection[];
  close: () => Promise<void>;
};

const handleLine = async (
  line: string,
  connection: RpcConnection,
  dispatch: RpcDispatchTable,
  registerOnClose: (callback: () => void) => () => void,
): Promise<void> => {
  const { socket } = connection;
  let request: JsonRpcRequest;

  try {
    const parsed: unknown = JSON.parse(line);

    if (!isPlainObject(parsed)) {
      writeErrorLine(socket, null, -32600, "Invalid Request: expected a JSON object.");
      return;
    }

    request = parsed;
  } catch {
    writeErrorLine(socket, null, -32700, "Parse error: invalid JSON.");
    return;
  }

  const id = hasRequestId(request) ? request.id : null;

  if (typeof request.method !== "string" || request.method.length === 0) {
    writeErrorLine(socket, id, -32600, 'Invalid Request: "method" must be a non-empty string.');
    return;
  }

  const handler = dispatch[request.method];

  if (!handler) {
    writeErrorLine(socket, id, -32601, `Method not found: "${request.method}".`);
    return;
  }

  const afterSendCallbacks: Array<() => void> = [];
  const context: RpcHandlerContext = {
    connection,
    afterSend: (callback) => {
      afterSendCallbacks.push(callback);
    },
    onClose: registerOnClose,
  };

  try {
    const result = await handler(request.params, context);

    writeLine(socket, { jsonrpc: "2.0", id, result: result ?? null }, () => {
      for (const callback of afterSendCallbacks) {
        callback();
      }
    });
  } catch (error) {
    if (error instanceof RpcApplicationError) {
      writeErrorLine(socket, id, error.code, error.message, {
        type: error.type,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Internal error.";
    writeErrorLine(socket, id, -32603, message, { type: "invalid_request" });
  }
};

export const startRpcServer = async (options: RpcServerOptions): Promise<RpcServer> => {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const connections = new Map<number, RpcConnection>();
  let nextConnectionId = 1;

  await rm(options.socketPath, { force: true });

  const server = createServer((socket) => {
    socket.on("error", () => {
      // A dropped/reset client connection must never crash the daemon.
    });

    const id = nextConnectionId;
    nextConnectionId += 1;

    const connection: RpcConnection = { id, socket, state: {} };
    connections.set(id, connection);

    const closeCallbacks = new Set<() => void>();
    const registerOnClose = (callback: () => void): (() => void) => {
      closeCallbacks.add(callback);
      return () => {
        closeCallbacks.delete(callback);
      };
    };

    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes && !buffer.includes("\n")) {
        socket.destroy();
        return;
      }

      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
            // ARCHITECTURE.md task notes: cap line length at 1 MiB, dropping the connection beyond.
            writeErrorLine(
              socket,
              null,
              -32600,
              `Invalid Request: line exceeds the ${maxLineBytes}-byte limit.`,
            );
            socket.destroy();
            return;
          }

          void handleLine(line, connection, options.dispatch, registerOnClose);
        }

        newlineIndex = buffer.indexOf("\n");
      }
    });

    socket.on("close", () => {
      connections.delete(id);

      const callbacks = Array.from(closeCallbacks);
      closeCallbacks.clear();

      for (const callback of callbacks) {
        try {
          callback();
        } catch {
          // A close callback must never crash the daemon.
        }
      }
    });
  });

  server.on("error", () => {
    // Never let a listener-level error (e.g. EMFILE after startup) crash the process. Startup
    // failures are additionally surfaced via the one-shot listener below, which rejects `listen()`.
    // Surfacing post-startup errors would require a caller-supplied sink; the daemon composition
    // root owns observability wiring in a later task.
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.socketPath);
  });

  await chmod(options.socketPath, 0o600);

  return {
    server,
    notify: (connection, payload) => {
      if (connection.socket.destroyed) {
        return;
      }

      // Backpressure guard: a slow/dead subscriber must never block the daemon or other
      // connections. `writableLength` reflects bytes already queued but not yet flushed to the
      // kernel; once it crosses the cap the connection is beyond saving and gets dropped.
      if (connection.socket.writableLength > MAX_NOTIFY_BUFFERED_BYTES) {
        connection.socket.destroy();
        return;
      }

      writeLine(connection.socket, { jsonrpc: "2.0", method: "event", params: payload });
    },
    connections: () => Array.from(connections.values()),
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections.values()) {
          connection.socket.destroy();
        }

        server.close(() => resolve());
      }),
  };
};
