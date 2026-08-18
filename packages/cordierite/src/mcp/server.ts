/**
 * The `cordierite mcp` stdio MCP server (ARCHITECTURE.md §9): a thin proxy that maps the daemon RPC
 * surface (`rpc/client.ts`, same auto-spawning client the CLI uses) onto MCP's `tools/list`,
 * `tools/call`, `notifications/tools/list_changed`, progress notifications, and one resource
 * (`cordierite://sessions`). All logging here goes to stderr only — stdout is reserved for the MCP
 * transport's protocol frames.
 *
 * One persistent daemon connection (`stream`) is used for everything except progress-correlated
 * `tools.call`s, which get their own short-lived connection (see `callProxiedTool` below) so the
 * `tool_call_started` event that reveals the call's `callId` is unambiguous.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { RPC_METHODS, type EventKind, type EventNotification, type SessionsListResult, type ToolsCallResult } from "@cordierite/shared";

import type { ExecFn } from "../cli/open-target.js";
import { DaemonRpcError, openDaemonStream, type SpawnFn } from "../rpc/client.js";
import {
  CONNECT_TOOL_DESCRIPTOR,
  CONNECT_TOOL_NAME,
  handleConnectTool,
  handleWaitForSessionTool,
  McpBuiltinToolError,
  WAIT_FOR_SESSION_TOOL_DESCRIPTOR,
  WAIT_FOR_SESSION_TOOL_NAME,
} from "./connect-tool.js";
import { fetchEffectiveTools } from "./daemon-tools.js";
import {
  EVENTS_TOOL_DESCRIPTOR,
  EVENTS_TOOL_NAME,
  handleEventsTool,
  handleWaitForEventTool,
  WAIT_FOR_EVENT_TOOL_DESCRIPTOR,
  WAIT_FOR_EVENT_TOOL_NAME,
} from "./events-tool.js";
import { toMcpTool } from "./tool-mapping.js";
import { findNamespacedTool, namespacedToolsSnapshotKey, type NamespacedTool } from "./tool-namespace.js";

const packageVersion: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
).version;

export const SESSIONS_RESOURCE_URI = "cordierite://sessions";

/** Event kinds whose arrival can change the effective (namespaced or not) tool list — including
 * the single↔multi namespacing flip itself, which is driven by session count, not tool count. */
const LIST_CHANGE_EVENT_KINDS: readonly EventKind[] = [
  "tools_changed",
  "session_claimed",
  "session_revoked",
  "session_expired",
  "session_suspended",
  "session_resumed",
];

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const toolSuccessContent = (result: unknown): CallToolResult => {
  const content = [{ type: "text" as const, text: JSON.stringify(result) }];

  if (isPlainObject(result)) {
    return { content, structuredContent: result };
  }

  return { content };
};

/** Errors from a tool call — proxied device tool or built-in management tool alike — become MCP
 * tool-error *content*, never a thrown protocol-level error: the preserved
 * `type` and `message` are put in the text so an agent reading the result can branch on them. */
const toolErrorContent = (type: string, message: string, details?: unknown): CallToolResult => {
  const suffix = details !== undefined ? ` ${JSON.stringify(details)}` : "";

  return {
    isError: true,
    content: [{ type: "text", text: `${type}: ${message}${suffix}` }],
  };
};

const toolErrorContentFromError = (error: unknown): CallToolResult => {
  if (error instanceof DaemonRpcError && error.data?.type) {
    return toolErrorContent(error.data.type, error.message, error.data.details);
  }

  if (error instanceof McpBuiltinToolError) {
    return toolErrorContent(error.type, error.message);
  }

  if (error instanceof Error) {
    return toolErrorContent("tool_execution_error", error.message);
  }

  return toolErrorContent("tool_execution_error", "An unexpected error occurred.");
};

export type CreateMcpServerOptions = {
  stateDir: string;
  spawn?: SpawnFn;
  /** The scheme composing `cordierite_connect`'s deep link; same source as `cli/link.ts`'s
   * `config.json`'s `scheme` (there is no per-call MCP flag equivalent). */
  scheme?: string;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
};

export type McpServerHandle = {
  server: Server;
  connect: (transport: Transport) => Promise<void>;
  close: () => Promise<void>;
};

export const createMcpServer = async (options: CreateMcpServerOptions): Promise<McpServerHandle> => {
  const stream = await openDaemonStream({ stateDir: options.stateDir, spawn: options.spawn });

  const server = new Server(
    { name: "cordierite", version: packageVersion },
    { capabilities: { tools: { listChanged: true }, resources: {} } },
  );

  const callProxiedTool = async (
    tool: NamespacedTool,
    args: Record<string, unknown>,
    progressToken: string | number | undefined,
    sendNotification: (notification: unknown) => Promise<void>,
  ): Promise<unknown> => {
    if (progressToken === undefined) {
      const result = await stream.call<ToolsCallResult>(RPC_METHODS.toolsCall, {
        selector: tool.selector,
        name: tool.descriptor.name,
        args,
        caller: "mcp",
      });

      return result.result;
    }

    // A dedicated connection carries only this one in-flight `tools.call`, so the first
    // `tool_call_started` it sees for this tool name is unambiguously this call — the daemon only
    // reveals `callId` once the call is already in flight (ARCHITECTURE.md §5's `ToolsCallResult`
    // doc comment), so this is the only way to correlate it before the call finishes.
    const progressStream = await openDaemonStream({ stateDir: options.stateDir, spawn: options.spawn });

    try {
      await progressStream.call(RPC_METHODS.eventsSubscribe, {
        sessionSelector: tool.selector,
        kinds: ["tool_call_started", "tool_call_progress"],
      });

      let callId: string | undefined;

      const unsubscribe = progressStream.onNotification((payload) => {
        const event = payload as EventNotification;

        if (event.kind === "tool_call_started" && callId === undefined) {
          const data = event.data as { name?: string; callId?: string };

          if (data.name === tool.descriptor.name) {
            callId = data.callId;
          }

          return;
        }

        if (event.kind === "tool_call_progress" && callId !== undefined) {
          const data = event.data as { callId?: string; progress?: number; message?: string };

          if (data.callId === callId) {
            sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: data.progress ?? 0, message: data.message },
            }).catch((error: unknown) => {
              console.error("cordierite mcp: failed to send a progress notification:", error);
            });
          }
        }
      });

      try {
        const result = await progressStream.call<ToolsCallResult>(RPC_METHODS.toolsCall, {
          selector: tool.selector,
          name: tool.descriptor.name,
          args,
          caller: "mcp",
        });

        return result.result;
      } finally {
        unsubscribe();
      }
    } finally {
      progressStream.close();
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await fetchEffectiveTools(stream.call);

    return {
      tools: [
        CONNECT_TOOL_DESCRIPTOR,
        WAIT_FOR_SESSION_TOOL_DESCRIPTOR,
        EVENTS_TOOL_DESCRIPTOR,
        WAIT_FOR_EVENT_TOOL_DESCRIPTOR,
        ...tools.map(toMcpTool),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const progressToken = extra._meta?.progressToken;

    try {
      if (name === CONNECT_TOOL_NAME) {
        return toolSuccessContent(
          await handleConnectTool(args, { call: stream.call, scheme: options.scheme, exec: options.exec, env: options.env }),
        );
      }

      if (name === WAIT_FOR_SESSION_TOOL_NAME) {
        return toolSuccessContent(
          await handleWaitForSessionTool(args, { stateDir: options.stateDir, spawn: options.spawn }),
        );
      }

      if (name === EVENTS_TOOL_NAME) {
        return toolSuccessContent(await handleEventsTool(args, { call: stream.call }));
      }

      if (name === WAIT_FOR_EVENT_TOOL_NAME) {
        return toolSuccessContent(
          await handleWaitForEventTool(args, {
            stateDir: options.stateDir,
            spawn: options.spawn,
            progress:
              progressToken !== undefined
                ? { token: progressToken, sendNotification: extra.sendNotification as (notification: unknown) => Promise<void> }
                : undefined,
          }),
        );
      }

      const tools = await fetchEffectiveTools(stream.call);
      const tool = findNamespacedTool(tools, name);

      if (!tool) {
        return toolErrorContent("tool_not_found", `Tool "${name}" is not registered.`);
      }

      return toolSuccessContent(
        await callProxiedTool(
          tool,
          args,
          progressToken,
          extra.sendNotification as (notification: unknown) => Promise<void>,
        ),
      );
    } catch (error) {
      return toolErrorContentFromError(error);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: SESSIONS_RESOURCE_URI,
          name: "sessions",
          description: "Live Cordierite device sessions (sessions.list passthrough), as JSON.",
          mimeType: "application/json",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== SESSIONS_RESOURCE_URI) {
      throw new Error(`Unknown resource "${request.params.uri}".`);
    }

    const sessions = await stream.call<SessionsListResult>(RPC_METHODS.sessionsList);

    return {
      contents: [{ uri: SESSIONS_RESOURCE_URI, mimeType: "application/json", text: JSON.stringify(sessions) }],
    };
  });

  // --- notifications/tools/list_changed ---

  let lastSnapshotKey: string | undefined;
  let closed = false;

  const refreshAndMaybeNotifyListChanged = async (): Promise<void> => {
    const tools = await fetchEffectiveTools(stream.call);

    if (closed) {
      return;
    }

    const key = namespacedToolsSnapshotKey(tools);
    const changed = lastSnapshotKey !== undefined && key !== lastSnapshotKey;
    lastSnapshotKey = key;

    if (changed) {
      await server.sendToolListChanged();
    }
  };

  const unsubscribeFromDaemonEvents = stream.onNotification((payload) => {
    const event = payload as EventNotification;

    if (LIST_CHANGE_EVENT_KINDS.includes(event.kind)) {
      refreshAndMaybeNotifyListChanged().catch((error: unknown) => {
        if (closed) {
          // Expected: the shared connection closed (server shutting down) while a refresh
          // triggered by the last few daemon events was still in flight.
          return;
        }

        // A failed refresh/notify must never crash the process — the next qualifying event (or the
        // client's own next `tools/list`) will simply see the current state instead.
        console.error("cordierite mcp: failed to refresh the tool list after a daemon event:", error);
      });
    }
  });

  await stream.call(RPC_METHODS.eventsSubscribe, { kinds: LIST_CHANGE_EVENT_KINDS as EventKind[] });
  // Establish the baseline before any daemon event can race a real change in — the guard above
  // (`lastSnapshotKey !== undefined`) means this first call only seeds state, never notifies.
  await refreshAndMaybeNotifyListChanged();

  const close = async (): Promise<void> => {
    closed = true;
    unsubscribeFromDaemonEvents();
    stream.close();
  };

  return {
    server,
    connect: (transport) => server.connect(transport),
    close,
  };
};
