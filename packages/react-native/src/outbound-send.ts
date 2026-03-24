import { isSessionBoundMessage } from "@cordierite/shared";

import type {
  CordieriteConnectionState,
  CordieriteOutboundMessage,
} from "./Cordierite.types";
import { logger } from "./logger";

export type OutboundSendDeps = {
  getState: () => CordieriteConnectionState;
  getSessionId: () => string | null;
  sendRaw: (jsonString: string) => Promise<void>;
};

/**
 * Validates session, normalizes `session_id`, and forwards JSON to native `send`.
 */
export const sendOutboundMessage = async (
  deps: OutboundSendDeps,
  message: CordieriteOutboundMessage
): Promise<void> => {
  const { getState, getSessionId, sendRaw } = deps;
  const currentSessionId = getSessionId();

  if (getState() !== "active" || !currentSessionId) {
    logger.debug("send rejected: session not active");
    throw new Error("Cordierite session is not active.");
  }

  if (typeof message === "string") {
    const parsed = JSON.parse(message) as unknown;
    const sessionBoundMessage = isSessionBoundMessage(parsed) ? parsed : null;

    if (
      sessionBoundMessage &&
      sessionBoundMessage.session_id !== currentSessionId
    ) {
      logger.debug("send rejected: session_id mismatch");
      throw new Error(
        "Outgoing Cordierite message session_id does not match the active session."
      );
    }

    logger.debug("send (raw string)");
    await sendRaw(message);
    return;
  }

  const payload = { ...message };

  if ("session_id" in payload && payload.session_id !== undefined) {
    if (payload.session_id !== currentSessionId) {
      logger.debug("send rejected: session_id mismatch");
      throw new Error(
        "Outgoing Cordierite message session_id does not match the active session."
      );
    }
  } else {
    payload.session_id = currentSessionId;
  }

  logger.debug("send", payload.type);
  await sendRaw(JSON.stringify(payload));
};
