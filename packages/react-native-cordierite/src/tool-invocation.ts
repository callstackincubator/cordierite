import { isToolCallMessage } from "cordierite-shared";

import type {
  CordieriteRegisteredTool,
  CordieriteToolExecutionContext,
} from "./Cordierite.types";
import { logger } from "./logger";
import { validateStandardSchema } from "./schema";

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
};

export const createToolMessageHandler = (deps: ToolInvocationDeps) => {
  const { getSessionId, getRegistry, sendWire } = deps;

  return async (rawMessage: unknown) => {
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
      await sendWire(
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
    };

    logger.debug("tool call", rawMessage.name, "id", rawMessage.id);

    try {
      const parsedArgs = await validateStandardSchema(
        tool.inputSchema,
        rawMessage.args
      );

      if (!parsedArgs.ok) {
        await sendWire(
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

      const result = await tool.handler(parsedArgs.value, context);
      const parsedResult = await validateStandardSchema(
        tool.outputSchema,
        result
      );

      if (!parsedResult.ok) {
        await sendWire(
          JSON.stringify({
            type: "tool_error",
            session_id: currentSessionId,
            id: rawMessage.id,
            error: {
              type: "tool_output_validation_error",
              message: `Tool "${rawMessage.name}" returned a result that does not match output_schema.`,
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
        await sendWire(
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

      await sendWire(
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
      await sendWire(
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
