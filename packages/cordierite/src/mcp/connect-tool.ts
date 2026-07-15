/**
 * The built-in `cordierite_connect` / `cordierite_wait_for_session` management tools
 * (ARCHITECTURE.md §9 scope item 4): let an MCP agent bootstrap a device session without shell
 * access — mint a link (and optionally deliver it via the task-07 emulator/simulator fast path),
 * then poll/wait for it to be claimed.
 */

import {
  RPC_METHODS,
  type EventNotification,
  type LinkCreateResult,
  type SessionsDescribeResult,
} from "@cordierite/shared";

import { deliverToOpenTarget, isOpenTarget, type ExecFn, type OpenTarget } from "../cli/open-target.js";
import { renderQrToTerminal } from "../qr-terminal.js";
import { openDaemonStream, DaemonRpcError, type SpawnFn } from "../rpc/client.js";
import type { DaemonCall } from "./daemon-tools.js";

export const CONNECT_TOOL_NAME = "cordierite_connect";
export const WAIT_FOR_SESSION_TOOL_NAME = "cordierite_wait_for_session";

/** The emulator/simulator fast path forces `127.0.0.1` — same reasoning as `cli/link.ts`. */
const OPEN_TARGET_ADDRESS_OVERRIDE = "127.0.0.1";

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

export const CONNECT_TOOL_DESCRIPTOR = {
  name: CONNECT_TOOL_NAME,
  description:
    "Mint a Cordierite session link. With no target, returns a deep link and a scannable QR " +
    "(as text) for a human to open on a physical device. With target \"android\" or \"ios-sim\", " +
    "delivers the link directly to a booted emulator/simulator (no human needed) and returns " +
    "{ sessionId, delivered: true }. Follow up with cordierite_wait_for_session to know when the " +
    "device has connected.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["android", "ios-sim"] },
      ttlSeconds: { type: "number", exclusiveMinimum: 0 },
    },
    additionalProperties: false,
  },
} as const;

export const WAIT_FOR_SESSION_TOOL_DESCRIPTOR = {
  name: WAIT_FOR_SESSION_TOOL_NAME,
  description:
    "Wait for a session minted by cordierite_connect to be claimed by a device. Resolves as soon " +
    "as the device connects (or immediately if it already has); rejects with tool_timeout if " +
    "timeoutMs elapses first.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      timeoutMs: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
} as const;

/** Errors from the built-in management tools reuse the daemon's wire `ErrorType` union
 * (`RpcApplicationError`-style: `{ type, message }`) so the MCP server's generic error-content
 * mapping (see `server.ts`) handles them the same way it handles a proxied device tool's error. */
export class McpBuiltinToolError extends Error {
  constructor(
    readonly type: "invalid_request" | "tool_timeout" | "tool_execution_error",
    message: string,
  ) {
    super(message);
    this.name = "McpBuiltinToolError";
  }
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

const asOptionalOpenTarget = (value: unknown): OpenTarget | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !isOpenTarget(value)) {
    throw new McpBuiltinToolError("invalid_request", '"target" must be "android" or "ios-sim".');
  }

  return value;
};

const asOptionalPositiveNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a positive number.`);
  }

  return value;
};

export type ConnectToolDeps = {
  call: DaemonCall;
  /** The scheme composing the deep link (`<scheme>:///?cordierite=<payload>`); same source order as
   * `cli/link.ts`: `--scheme` flag equivalent has no MCP analogue, so this is always config/derived. */
  scheme?: string;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
};

export type ConnectToolResult = {
  sessionId: string;
  deepLink: string;
  expiresAt: number;
  delivered?: true;
  target?: OpenTarget;
  /** Present only when no target was given: a scannable QR of the deep link, rendered as text. */
  qr?: string;
};

export const handleConnectTool = async (
  rawArgs: unknown,
  deps: ConnectToolDeps,
): Promise<ConnectToolResult> => {
  const args = asRecord(rawArgs);

  const target = asOptionalOpenTarget(args.target);
  const ttlSeconds = asOptionalPositiveNumber(args.ttlSeconds, "ttlSeconds");

  if (!deps.scheme) {
    throw new McpBuiltinToolError(
      "invalid_request",
      'A deep-link scheme is required: set "scheme" in config.json.',
    );
  }

  const result = await deps.call<LinkCreateResult>(RPC_METHODS.linkCreate, {
    ttlSeconds,
    addressOverride: target ? OPEN_TARGET_ADDRESS_OVERRIDE : undefined,
  });

  const deepLink = `${deps.scheme}:///?cordierite=${result.deepLinkPayload}`;

  if (target) {
    try {
      await deliverToOpenTarget({
        target,
        deepLink,
        wssPort: result.endpoint.port,
        exec: deps.exec,
        env: deps.env,
      });
    } catch (error) {
      throw new McpBuiltinToolError(
        "tool_execution_error",
        error instanceof Error ? error.message : "Failed to deliver the deep link.",
      );
    }

    return { sessionId: result.sessionId, deepLink, expiresAt: result.expiresAt, delivered: true, target };
  }

  return {
    sessionId: result.sessionId,
    deepLink,
    expiresAt: result.expiresAt,
    qr: renderQrToTerminal(deepLink),
  };
};

export type WaitForSessionToolDeps = {
  stateDir: string;
  spawn?: SpawnFn;
};

export type WaitForSessionToolResult = {
  sessionId: string;
  claimed: true;
  alias: string;
};

export const handleWaitForSessionTool = async (
  rawArgs: unknown,
  deps: WaitForSessionToolDeps,
): Promise<WaitForSessionToolResult> => {
  const args = asRecord(rawArgs);

  if (typeof args.sessionId !== "string" || args.sessionId.length === 0) {
    throw new McpBuiltinToolError("invalid_request", '"sessionId" must be a non-empty string.');
  }

  const sessionId = args.sessionId;
  const timeoutMs = asOptionalPositiveNumber(args.timeoutMs, "timeoutMs") ?? DEFAULT_WAIT_TIMEOUT_MS;

  const stream = await openDaemonStream({ stateDir: deps.stateDir, spawn: deps.spawn });

  try {
    // The session may already be claimed by the time this tool runs (the agent called
    // cordierite_connect a while ago, or is polling) — resolve immediately rather than waiting for
    // an event that already happened.
    try {
      const existing = await stream.call<SessionsDescribeResult>(RPC_METHODS.sessionsDescribe, {
        selector: sessionId,
      });

      return { sessionId, claimed: true, alias: existing.alias };
    } catch (error) {
      if (!(error instanceof DaemonRpcError) || error.data?.type !== "unknown_session") {
        throw error;
      }
    }

    await stream.call(RPC_METHODS.eventsSubscribe, {
      sessionSelector: sessionId,
      kinds: ["session_claimed"],
    });

    return await new Promise<WaitForSessionToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          new McpBuiltinToolError(
            "tool_timeout",
            `Timed out after ${timeoutMs}ms waiting for session "${sessionId}" to be claimed.`,
          ),
        );
      }, timeoutMs);

      const unsubscribe = stream.onNotification((payload) => {
        const event = payload as EventNotification;

        if (event.kind === "session_claimed" && event.sessionId === sessionId) {
          clearTimeout(timer);
          unsubscribe();
          resolve({ sessionId, claimed: true, alias: event.alias ?? "" });
        }
      });
    });
  } finally {
    stream.close();
  }
};
