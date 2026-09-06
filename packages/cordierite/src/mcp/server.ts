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
 *
 * This is also where both `"prompt"`-policy consent channels live (ARCHITECTURE.md §12):
 * `resolveToolCallConsent` prefers `elicitation/create` (issue #10, any client that declares the
 * `elicitation` capability) over the `_meta["anthropic/requiresUserInteraction"]` flag (issue #14,
 * Claude Code ≥ v2.1.199 only), and the two never arm for the same call — see
 * `clientSupportsElicitation` and the `tools/list` handler below.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
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

/**
 * Whether the connected MCP client declared the `elicitation` capability at `initialize`
 * (ARCHITECTURE.md §12 / issue #10) — the preferred `"prompt"`-policy consent channel, checked
 * fresh on every call rather than cached (same principle as `clientHonorsRequiresUserInteraction`
 * above: nothing about consent is trusted from a stale snapshot). A bare `elicitation: {}` from the
 * client normalizes to `{ form: {} }` in the SDK's parsed capabilities (backwards-compat default),
 * which is what `server.elicitInput`'s own form-mode request actually requires — this check only
 * needs to know the key is present at all, and lets `elicitInput` itself fail (caught below, and
 * treated as "no channel", never as approval) if the specific mode turns out unsupported.
 */
const clientSupportsElicitation = (server: Server): boolean => {
  return server.getClientCapabilities()?.elicitation !== undefined;
};

/** Bounds an elicitation's wait server-side (ARCHITECTURE.md §9/§12 / issue #10) — comfortably
 * under the 30-minute idle window a stdio MCP tool call gets before Claude Code aborts it, so an
 * unanswered prompt resolves as a clean decline-shaped result naming the timeout rather than an
 * opaque abort at the transport's own limit. */
const ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;

/** Caps how much of a call's JSON-stringified `args` is rendered into an elicitation message body —
 * plenty to show a human what's about to run without flooding a prompt UI with a large payload. */
const ELICITATION_ARGS_PREVIEW_MAX_CHARS = 2048;

const formatElicitationArgsPreview = (args: Record<string, unknown>): string => {
  const json = JSON.stringify(args);

  if (json.length <= ELICITATION_ARGS_PREVIEW_MAX_CHARS) {
    return json;
  }

  return `${json.slice(0, ELICITATION_ARGS_PREVIEW_MAX_CHARS)}… [truncated at ${ELICITATION_ARGS_PREVIEW_MAX_CHARS} of ${json.length} characters]`;
};

/** Names the session alias, the tool, and the actual arguments — the human answering this prompt
 * has nothing else to go on (ARCHITECTURE.md §12 / issue #10). */
const buildElicitationMessage = (tool: NamespacedTool, args: Record<string, unknown>): string => {
  return (
    `Cordierite: allow the MCP tool "${tool.descriptor.name}" to run on session "${tool.selector}"? ` +
    `Arguments: ${formatElicitationArgsPreview(args)}`
  );
};

/** Thrown from `callProxiedTool` when the human declined or cancelled an elicitation prompt (or it
 * timed out), so the outer `tools/call` handler can turn it into an ordinary MCP tool **result**
 * with `isError: true` — never a thrown protocol-level error — matching every other error path in
 * this file (`toolErrorContentFromError` below): the agent reading the result must be able to
 * branch on "the user said no" the same way it branches on any other tool error. */
class ElicitationDeclinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElicitationDeclinedError";
  }
}

/**
 * Sends one `elicitation/create` request for a `"prompt"`-policy call and interprets the reply
 * (ARCHITECTURE.md §12 / issue #10). Three outcomes:
 * - `"accepted"`: the daemon call proceeds with `consent: "elicitation"`.
 * - `"declined"`: an explicit decline, a cancel, or a server-side timeout — all render as the same
 *   decline-shaped result to the agent; the daemon is never called.
 * - `"no-channel"`: the request itself failed even though the client declared the capability (it
 *   rejected `elicitation/create` as unsupported despite advertising it, a transport error, ...).
 *   This is deliberately **not** treated as approval — the caller falls through with no consent
 *   marker, which yields the daemon's existing `policy_denied`/`no_consent_channel` fail-closed
 *   path, exactly as if no channel had ever been offered.
 */
const requestElicitationConsent = async (
  server: Server,
  tool: NamespacedTool,
  args: Record<string, unknown>,
  // Injectable so tests can exercise the timeout branch without an actual 10-minute wait; every
  // production caller passes `ELICITATION_TIMEOUT_MS` (via `CreateMcpServerOptions.elicitationTimeoutMs`).
  timeoutMs: number,
): Promise<{ type: "accepted" } | { type: "declined"; message: string } | { type: "no-channel" }> => {
  try {
    const result = await server.elicitInput(
      {
        message: buildElicitationMessage(tool, args),
        // The accept/decline/cancel action itself is the consent signal — nothing is actually being
        // collected, so the schema asks for no fields. An empty `properties` record is a valid
        // restricted-JSON-Schema object per the MCP spec (the SDK's request schema requires the key
        // but not that it be non-empty), and renders as a plain confirm/decline prompt.
        requestedSchema: { type: "object", properties: {} },
      },
      { timeout: timeoutMs },
    );

    if (result.action === "accept") {
      return { type: "accepted" };
    }

    return {
      type: "declined",
      message: `The user ${result.action === "cancel" ? "cancelled" : "declined"} the request to call "${tool.descriptor.name}" on session "${tool.selector}".`,
    };
  } catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      return {
        type: "declined",
        message: `Timed out after ${timeoutMs / 1000}s waiting for a human to respond to the consent prompt for "${tool.descriptor.name}" on session "${tool.selector}".`,
      };
    }

    // The client declared the `elicitation` capability at `initialize` but the request itself
    // failed anyway (rejected as unsupported, transport error, ...). Never treat a failure as
    // approval.
    return { type: "no-channel" };
  }
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

  // A human declined/cancelled an elicitation prompt, or it timed out (ARCHITECTURE.md §12 /
  // issue #10) — the daemon was never called for this attempt.
  if (error instanceof ElicitationDeclinedError) {
    return toolErrorContent("consent_declined", error.message);
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
  /** `config.json`'s `iosBundleId`; the default bundle id for `cordierite_connect`'s experimental
   * `ios-device` target (issue #31). */
  iosBundleId?: string;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  /** Overrides `ELICITATION_TIMEOUT_MS` (ARCHITECTURE.md §12 / issue #10) — test-only seam so the
   * timeout branch of `requestElicitationConsent` can be exercised without an actual 10-minute
   * wait. Every real caller (`cli/mcp-command.ts`) leaves this unset. */
  elicitationTimeoutMs?: number;
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
  // nothing was shown to a human). `resolveToolCallConsent` requires membership here in addition to
  // recomputing the tool's live policy and the client check, so `consent: "client"` reflects an
  // MCP `Tool` the client actually listed with the flag set on *this* connection, not merely a
  // client that happens to qualify version-wise (ARCHITECTURE.md §12 / issue #14). Stays empty for
  // any connection where elicitation is preferred (issue #10) — see the `tools/list` handler below.
  const emittedRequiresUserInteraction = new Set<string>();

  /**
   * Resolves the `consent` param for one `"prompt"`-policy `tools.call` (ARCHITECTURE.md §12),
   * shared by both call paths below so the two channels' logic exists exactly once. Recomputes the
   * tool's live policy's implications at call time — never trusts anything cached from a prior
   * `tools/list` snapshot except membership in `emittedRequiresUserInteraction` above, which by
   * construction can only be true for *this* connection's most recent listing.
   *
   * Channel preference (never both armed for one call): elicitation (issue #10) whenever the
   * client declared the capability, else the flag-based gate (issue #14) as a fallback. An
   * elicitation decline/cancel/timeout throws `ElicitationDeclinedError` — the caller must not
   * catch it, since it belongs in the outer `tools/call` handler's result path, not lumped in with
   * "no consent obtained".
   */
  const resolveToolCallConsent = async (
    tool: NamespacedTool,
    args: Record<string, unknown>,
  ): Promise<"client" | "elicitation" | undefined> => {
    if (tool.policy !== "prompt") {
      return undefined;
    }

    if (clientSupportsElicitation(server)) {
      const outcome = await requestElicitationConsent(
        server,
        tool,
        args,
        options.elicitationTimeoutMs ?? ELICITATION_TIMEOUT_MS,
      );

      if (outcome.type === "accepted") {
        return "elicitation";
      }

      if (outcome.type === "declined") {
        throw new ElicitationDeclinedError(outcome.message);
      }

      // "no-channel": never fabricate approval from a failed request — fall through with no
      // consent so the daemon's own "prompt" gate denies the call exactly as it would for any
      // other ungated caller (ARCHITECTURE.md §12).
      return undefined;
    }

    return clientHonorsRequiresUserInteraction(server) && emittedRequiresUserInteraction.has(tool.mcpName)
      ? "client"
      : undefined;
  };

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
    const consent = await resolveToolCallConsent(tool, args);

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
    // Channel preference (ARCHITECTURE.md §12 / issues #10 & #14): elicitation always wins over the
    // flag-based gate when the client declared it, so a "prompt" tool never arms two consent UIs
    // for one call. When elicitation is preferred, the flag is suppressed entirely — this listing
    // never sets `_meta["anthropic/requiresUserInteraction"]`, `emittedRequiresUserInteraction`
    // stays empty, and `resolveToolCallConsent` above takes the elicitation branch at call time
    // instead.
    const emitRequiresUserInteractionFlag = !clientSupportsElicitation(server) && clientHonorsRequiresUserInteraction(server);

    emittedRequiresUserInteraction.clear();
    for (const tool of tools) {
      if (tool.policy === "prompt" && emitRequiresUserInteractionFlag) {
        emittedRequiresUserInteraction.add(tool.mcpName);
      }
    }

    return {
      tools: [
        CONNECT_TOOL_DESCRIPTOR,
        WAIT_FOR_SESSION_TOOL_DESCRIPTOR,
        EVENTS_TOOL_DESCRIPTOR,
        WAIT_FOR_EVENT_TOOL_DESCRIPTOR,
        ...tools.map((tool) => mapToMcpTool(tool, emitRequiresUserInteractionFlag)),
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
          await handleConnectTool(args, {
            call: stream.call,
            scheme: options.scheme,
            iosBundleId: options.iosBundleId,
            exec: options.exec,
            env: options.env,
          }),
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
