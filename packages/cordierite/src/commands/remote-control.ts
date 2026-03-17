import { connectionError, toolError } from "../errors.js";
import { resolveSessionRegistryEntry } from "../session-registry.js";

export const requestHostControlForSession = async <TResult>(
  sessionId: string,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
): Promise<TResult> => {
  const entry = await resolveSessionRegistryEntry(sessionId);
  const response = await fetch(`http://127.0.0.1:${entry.controlPort}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = (await response.json()) as
    | {
        ok: true;
        data: TResult;
      }
    | {
        ok: false;
        error: {
          type: string;
          message: string;
          details?: unknown;
        };
      };

  if (!response.ok || !payload.ok) {
    const errorType = payload.ok ? "connection_error" : payload.error.type;

    if (
      errorType === "tool_error" ||
      errorType === "tool_not_found" ||
      errorType === "tool_input_validation_error" ||
      errorType === "tool_output_validation_error" ||
      errorType === "tool_execution_error" ||
      errorType === "tool_serialization_error" ||
      errorType === "tool_timeout"
    ) {
      throw toolError(payload.ok ? "Cordierite host control request failed." : payload.error.message, {
        path: pathname,
        details: payload.ok ? undefined : payload.error.details,
      });
    }

    throw connectionError(payload.ok ? "Cordierite host control request failed." : payload.error.message, {
      path: pathname,
      details: payload.ok ? undefined : payload.error.details,
    });
  }

  return payload.data;
};

export const requestHostControlForSessionIfPresent = async <TResult>(
  sessionId: string,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
): Promise<TResult | null> => {
  try {
    return await requestHostControlForSession<TResult>(sessionId, method, pathname, body);
  } catch (error) {
    if (error instanceof Error && "type" in error) {
      const type = String((error as { type?: unknown }).type);
      if (type === "connection_error") {
        return null;
      }
    }

    if (error instanceof Error) {
      return null;
    }

    throw error;
  }
};
