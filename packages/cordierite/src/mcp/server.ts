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
import { clampTimeout, deriveCallTransportTimeoutMs } from "../daemon/calls.js";
import { getPackageVersion } from "../package-version.js";
import {
  DaemonRpcError,
  DaemonVersionMismatchError,
  openDaemonStream,
  type DaemonStream,
  type SpawnFn,
  type VersionCheckOptions,
} from "../rpc/client.js";
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
import { createMcpToolMapper, emitsMcpOutputSchema } from "./tool-mapping.js";
import { findNamespacedTool, namespacedToolsSnapshotKey, type NamespacedTool } from "./tool-namespace.js";

const packageVersion = getPackageVersion();

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

/** The *shape* of a rejected tool result, for the error message only — never the value itself,
 * which may be large or carry app data that does not belong in an agent-visible error string. */
const describeJsonValue = (value: unknown): string => {
  if (value === null) {
    return "null";
  }

  // Defensive: the daemon rejects a `tool_result` frame with no `result`, so nothing on today's
  // wire path yields `undefined` here. Spelled out anyway so a future one reads as "returned no
  // value" rather than the `typeof` wording, "returned a undefined".
  if (value === undefined) {
    return "no value";
  }

  if (Array.isArray(value)) {
    return "an array";
  }

  return `a ${typeof value}`;
};

/** The minimum Claude Code version documented (ARCHITECTURE.md §12 / issue #14) to enforce
 * `_meta["anthropic/requiresUserInteraction"]` on every call, in every permission mode, with no
 * "don't ask again" option. Older Claude Code and every other client ignore the flag silently. */
const REQUIRES_USER_INTERACTION_MIN_VERSION = [2, 1, 199] as const;

/** Strict `\d+` per dot-separated part — rejects a pre-release/build suffix (`"2.1.199-beta.1"`,
 * `"2.1.199rc"`) rather than letting `Number.parseInt`'s leading-digits-only parsing treat it as
 * `2.1.199` and wrongly report a pre-release as version-compliant. */
const parseVersionParts = (version: string): number[] | undefined => {
  const rawParts = version.split(".");

  if (!rawParts.every((part) => /^\d+$/u.test(part))) {
    return undefined;
  }

  return rawParts.map((part) => Number.parseInt(part, 10));
};

const isVersionAtLeast = (version: string, min: readonly number[]): boolean => {
  const parts = parseVersionParts(version);

  if (!parts) {
    return false;
  }

  for (let i = 0; i < min.length; i++) {
    const part = parts[i] ?? 0;

    if (part > min[i]!) {
      return true;
    }

    if (part < min[i]!) {
      return false;
    }
  }

  return true;
};

/**
 * Whether the connected MCP client is known to enforce `_meta["anthropic/requiresUserInteraction"]`
 * (ARCHITECTURE.md §12 / issue #14). `clientInfo` is self-reported at `initialize` — a hostile
 * client could claim to be Claude Code, but that is outside this feature's threat model
 * (unattended automation, not a malicious client); it is documented as a known limitation.
 */
const clientHonorsRequiresUserInteraction = (server: Server): boolean => {
  const clientInfo = server.getClientVersion();
  return clientInfo?.name === "claude-code" && isVersionAtLeast(clientInfo.version, REQUIRES_USER_INTERACTION_MIN_VERSION);
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

/**
 * The success path for a *proxied* device tool (issue #26). An MCP client requires
 * `structuredContent` on every successful call to a tool whose `tools/list` entry carried an
 * `outputSchema`, so this shares `emitsMcpOutputSchema` with the mapping layer: the two decisions
 * are the same predicate and cannot drift. When a schema *was* advertised and the result is not an
 * object anyway (reachable only when the schema's validator is looser than its declared shape,
 * `tool-invocation.ts`), the call fails as `tool_output_validation_error` rather than as an opaque
 * client-side protocol error. A tool whose schema was dropped, or that has none, keeps the
 * opportunistic behaviour: text content always, plus `structuredContent` when the result happens
 * to be an object — which is allowed, since the client has no schema to validate it against.
 */
const proxiedToolResultContent = (tool: NamespacedTool, result: unknown): CallToolResult => {
  if (!emitsMcpOutputSchema(tool.descriptor.output_schema)) {
    return toolSuccessContent(result);
  }

  if (!isPlainObject(result)) {
    return toolErrorContent(
      "tool_output_validation_error",
      `Tool "${tool.mcpName}" declares an object output schema but returned ${describeJsonValue(result)}.`,
    );
  }

  return toolSuccessContent(result);
};

export type CreateMcpServerOptions = {
  stateDir: string;
  spawn?: SpawnFn;
  /**
   * Daemon/CLI version check (issue #30), applied to the startup stream only — never to the
   * short-lived progress streams below, which must never restart the daemon out from under a call
   * that is already in flight. A mismatch that cannot be resolved therefore fails server startup,
   * with the same message the CLI prints. Drift introduced *after* this server started is out of
   * scope: nothing re-checks a connection that is already established.
   */
  checkVersion?: VersionCheckOptions;
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
  let stream: DaemonStream;

  try {
    stream = await openDaemonStream({
      stateDir: options.stateDir,
      spawn: options.spawn,
      checkVersion: options.checkVersion,
    });
  } catch (error) {
    if (error instanceof DaemonVersionMismatchError) {
      // An MCP client renders a startup failure as a bare "server failed to start" with no cause,
      // and the operator never sees the thrown message. This stderr line — which the client's own
      // logs keep — is the only place the actual diagnosis reaches a human (ARCHITECTURE.md §4).
      console.error(`cordierite mcp: refusing to start. ${error.message}`);
    }

    throw error;
  }

  const server = new Server(
    { name: "cordierite", version: packageVersion },
    { capabilities: { tools: { listChanged: true }, resources: {} } },
  );

  // The `mcpName`s this connection's *most recent* `tools/list` response actually emitted
  // `_meta["anthropic/requiresUserInteraction"]` for — repopulated on every `tools/list` request,
  // never on the internal `list_changed` refresh below (which doesn't answer a client request, so
  // nothing was shown to a human). `callProxiedTool` requires membership here in addition to
  // recomputing the tool's live policy and the client check, so `consent: "client"` reflects an
  // MCP `Tool` the client actually listed with the flag set on *this* connection, not merely a
  // client that happens to qualify version-wise (ARCHITECTURE.md §12 / issue #14).
  const emittedRequiresUserInteraction = new Set<string>();

  // One mapper per server: it owns the dedup for the "this schema had to be degraded" stderr
  // notices, which would otherwise repeat on every `tools/list` and every list-changed refresh.
  const mapToMcpTool = createMcpToolMapper();

  const callProxiedTool = async (
    tool: NamespacedTool,
    args: Record<string, unknown>,
    progressToken: string | number | undefined,
    sendNotification: (notification: unknown) => Promise<void>,
    // The MCP SDK aborts this automatically on an inbound `notifications/cancelled` for this
    // request (ARCHITECTURE.md §9). Only honored on the progress-tracked path below, which is the
    // only one that learns `callId` while the call is still in flight — a non-progress call has no
    // `callId` to cancel by until it has already resolved.
    signal: AbortSignal,
  ): Promise<unknown> => {
    // Recomputed at call time (never cached from the `tools/list` snapshot) so a stale `_meta`
    // can't be replayed to manufacture consent (ARCHITECTURE.md §12 / issue #14): this is the
    // daemon's sole evidence a human gate exists for a "prompt"-policy tool.
    const consent: "client" | undefined =
      tool.policy === "prompt" &&
      clientHonorsRequiresUserInteraction(server) &&
      emittedRequiresUserInteraction.has(tool.mcpName)
        ? "client"
        : undefined;

    // The deadline this call runs under, resolved once from the `tools.list` snapshot it was
    // matched against, and sent explicitly rather than left to the daemon's `?? tool.timeout_ms`
    // fallback. `clampTimeout` folds in the 10 s default for a tool that declares nothing, so
    // there is exactly one number here and the watchdog below can never be sized off a different
    // read: the daemon consults its live registry, which a re-registration between that snapshot
    // and this call could have moved, and a watchdog built for the older value would fire first
    // and mask the daemon's real `tool_timeout` (issue #25).
    const timeoutMs = clampTimeout(tool.descriptor.timeout_ms);
    const transportTimeoutMs = deriveCallTransportTimeoutMs(timeoutMs);

    if (progressToken === undefined) {
      const result = await stream.call<ToolsCallResult>(
        RPC_METHODS.toolsCall,
        {
          selector: tool.selector,
          name: tool.descriptor.name,
          args,
          caller: "mcp",
          timeoutMs,
          ...(consent ? { consent } : {}),
        },
        transportTimeoutMs,
      );

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
      let cancelRequested = signal.aborted;

      const maybeCancel = (): void => {
        if (callId === undefined || !cancelRequested) {
          return;
        }

        progressStream
          .call(RPC_METHODS.toolsCancel, { selector: tool.selector, callId, reason: "mcp_client_cancelled" })
          .catch((error: unknown) => {
            console.error("cordierite mcp: failed to cancel a proxied tool call:", error);
          });
      };

      const onAbort = (): void => {
        cancelRequested = true;
        maybeCancel();
      };

      signal.addEventListener("abort", onAbort);

      const unsubscribe = progressStream.onNotification((payload) => {
        const event = payload as EventNotification;

        if (event.kind === "tool_call_started" && callId === undefined) {
          const data = event.data as { name?: string; callId?: string };

          if (data.name === tool.descriptor.name) {
            callId = data.callId;
            maybeCancel();
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
        const result = await progressStream.call<ToolsCallResult>(
          RPC_METHODS.toolsCall,
          {
            selector: tool.selector,
            name: tool.descriptor.name,
            args,
            caller: "mcp",
            timeoutMs,
            ...(consent ? { consent } : {}),
          },
          transportTimeoutMs,
        );

        return result.result;
      } finally {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
      }
    } finally {
      progressStream.close();
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await fetchEffectiveTools(stream.call);
    const clientHonors = clientHonorsRequiresUserInteraction(server);

    emittedRequiresUserInteraction.clear();
    for (const tool of tools) {
      if (tool.policy === "prompt" && clientHonors) {
        emittedRequiresUserInteraction.add(tool.mcpName);
      }
    }

    return {
      tools: [
        CONNECT_TOOL_DESCRIPTOR,
        WAIT_FOR_SESSION_TOOL_DESCRIPTOR,
        EVENTS_TOOL_DESCRIPTOR,
        WAIT_FOR_EVENT_TOOL_DESCRIPTOR,
        ...tools.map((tool) => mapToMcpTool(tool, clientHonors)),
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

      return proxiedToolResultContent(
        tool,
        await callProxiedTool(
          tool,
          args,
          progressToken,
          extra.sendNotification as (notification: unknown) => Promise<void>,
          extra.signal,
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
