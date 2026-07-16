import { isToolCallMessage } from "@cordierite/shared";

import type {
  CordieriteRegisteredTool,
  CordieriteToolExecutionContext,
  CordieriteUnifiedErrorEvent,
} from "../Cordierite.types";
import { logger } from "../logger";
import { validateStandardSchema } from "../schema";
import type { ClientTimers } from "./timers";

export const normalizeThrownError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      type: "tool_execution_error" as const,
      message: error.message,
      details: {
        name: error.name,
      },
    };
  }

  return {
    type: "tool_execution_error" as const,
    message: "Cordierite tool execution failed.",
    details: error,
  };
};

export type ToolInvocationDeps = {
  getSessionId: () => string | null;
  getRegistry: () => Map<string, CordieriteRegisteredTool>;
  sendWire: (json: string) => Promise<void>;
  timers: ClientTimers;
  onError: (event: CordieriteUnifiedErrorEvent) => void;
};

/** Best-effort send: logs and reports to the unified error channel instead of throwing. */
const sendWireSafely = async (
  sendWire: (json: string) => Promise<void>,
  json: string,
  onError: ToolInvocationDeps["onError"]
): Promise<void> => {
  try {
    await sendWire(json);
  } catch (error) {
    logger.warn("Cordierite failed to send a tool response", error);
    onError({
      phase: "tool",
      message: "Failed to send a tool response frame.",
      cause: error,
    });
  }
};

export const createToolMessageHandler = (deps: ToolInvocationDeps) => {
  const { getSessionId, getRegistry, sendWire, timers, onError } = deps;
  const send = (json: string) => sendWireSafely(sendWire, json, onError);

  return async (rawMessage: unknown): Promise<void> => {
    const currentSessionId = getSessionId();
    if (!currentSessionId || !isToolCallMessage(rawMessage)) {
      return;
    }

    const registry = getRegistry();
    const tool = registry.get(rawMessage.name);

    if (!tool) {
      logger.warn(
        `tool call for unregistered tool "${rawMessage.name}" (id ${rawMessage.id})`
      );
      await send(
        JSON.stringify({
          type: "tool_error",
          session_id: currentSessionId,
          id: rawMessage.id,
          error: {
            type: "tool_not_found",
            message: `Tool "${rawMessage.name}" is not registered in the app.`,
          },
        })
      );
      return;
    }

    const context: CordieriteToolExecutionContext = {
      sessionId: currentSessionId,
      invocationId: rawMessage.id,
      receivedAt: new Date().toISOString(),
      reportProgress: (progress, message) =>
        send(
          JSON.stringify({
            type: "tool_call_progress",
            session_id: currentSessionId,
            id: rawMessage.id,
            ...(progress !== undefined ? { progress } : {}),
            ...(message !== undefined ? { message } : {}),
          })
        ),
    };

    logger.debug("tool call", rawMessage.name, "id", rawMessage.id);

    try {
      const parsedArgs = tool.inputSchema
        ? await validateStandardSchema(tool.inputSchema, rawMessage.args)
        : Object.keys(rawMessage.args).length === 0
        ? {
            ok: true as const,
            value: undefined,
          }
        : {
            ok: false as const,
            issues: [
              {
                message: `Tool "${rawMessage.name}" does not accept input arguments.`,
              },
            ],
          };

      if (!parsedArgs.ok) {
        await send(
          JSON.stringify({
            type: "tool_error",
            session_id: currentSessionId,
            id: rawMessage.id,
            error: {
              type: "tool_input_validation_error",
              message: `Tool "${rawMessage.name}" rejected the provided input.`,
              details: {
                issues: parsedArgs.issues,
              },
            },
          })
        );
        return;
      }

      let timedOut = false;
      const timeoutHandle = timers.setTimeout(() => {
        timedOut = true;
        void send(
          JSON.stringify({
            type: "tool_error",
            session_id: currentSessionId,
            id: rawMessage.id,
            error: {
              type: "tool_timeout",
              message: `Tool "${rawMessage.name}" did not respond within ${tool.timeoutMs}ms.`,
            },
          })
        );
      }, tool.timeoutMs);

      let result: unknown;
      try {
        result = await tool.handler(parsedArgs.value, context);
      } catch (error) {
        timers.clearTimeout(timeoutHandle);
        if (timedOut) {
          logger.devWarn(
            `tool "${rawMessage.name}" threw after its ${tool.timeoutMs}ms timeout (id ${rawMessage.id}); ignoring the late result.`
          );
          return;
        }
        throw error;
      }

      timers.clearTimeout(timeoutHandle);
      if (timedOut) {
        logger.devWarn(
          `tool "${rawMessage.name}" resolved after its ${tool.timeoutMs}ms timeout (id ${rawMessage.id}); ignoring the late result.`
        );
        return;
      }

      const parsedResult = tool.outputSchema
        ? await validateStandardSchema(tool.outputSchema, result)
        : result === undefined
        ? {
            ok: true as const,
            value: null,
          }
        : {
            ok: false as const,
            issues: [
              {
                message: `Tool "${rawMessage.name}" must not return a result when outputSchema is omitted.`,
              },
            ],
          };

      if (!parsedResult.ok) {
        await send(
          JSON.stringify({
            type: "tool_error",
            session_id: currentSessionId,
            id: rawMessage.id,
            error: {
              type: "tool_output_validation_error",
              message: `Tool "${rawMessage.name}" returned a result that does not match outputSchema.`,
              details: {
                issues: parsedResult.issues,
              },
            },
          })
        );
        return;
      }

      try {
        JSON.stringify(parsedResult.value);
      } catch (error) {
        logger.warn(
          `tool "${rawMessage.name}" result not JSON-serializable (id ${rawMessage.id})`,
          error
        );
        await send(
          JSON.stringify({
            type: "tool_error",
            session_id: currentSessionId,
            id: rawMessage.id,
            error: {
              type: "tool_serialization_error",
              message: "Cordierite tool result is not JSON-serializable.",
              details: normalizeThrownError(error),
            },
          })
        );
        return;
      }

      await send(
        JSON.stringify({
          type: "tool_result",
          session_id: currentSessionId,
          id: rawMessage.id,
          result: parsedResult.value,
        })
      );
    } catch (error) {
      logger.warn(
        `tool "${rawMessage.name}" handler threw (id ${rawMessage.id})`,
        error
      );
      onError({
        phase: "tool",
        message: `Tool "${rawMessage.name}" handler threw.`,
        cause: error,
        toolName: rawMessage.name,
        invocationId: rawMessage.id,
      });
      await send(
        JSON.stringify({
          type: "tool_error",
          session_id: currentSessionId,
          id: rawMessage.id,
          error: normalizeThrownError(error),
        })
      );
    }
  };
};
