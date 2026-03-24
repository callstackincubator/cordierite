import {
  canClaimPendingSession,
  formatAgentWebSocketUrl,
  type CliResult,
  type ConnectCommandData,
} from "@cordierite/shared";

import { parseBootstrapPayload } from "../parse.js";
import type { CommandContext } from "../runtime.js";

export type ConnectCommandOptions = {
  payload: string;
  requirePrivateIp?: boolean;
};

export const handleConnectCommand = (
  options: ConnectCommandOptions,
  context: CommandContext,
): CliResult<ConnectCommandData> => {
  const now = context.clock.now();
  const nowUnixSeconds = Math.floor(now.getTime() / 1000);
  const payload = parseBootstrapPayload(options.payload, {
    nowUnixSeconds,
    requirePrivateIp: options.requirePrivateIp,
  });

  return {
    ok: true,
    data: {
      bootstrap: {
        session_id: payload.sessionId,
        endpoint: {
          ip: payload.ip,
          port: payload.port,
          url: formatAgentWebSocketUrl(payload),
        },
        expires_at: payload.expiresAt,
        expires_at_iso: new Date(payload.expiresAt * 1000).toISOString(),
        can_claim: canClaimPendingSession(
          {
            ip: payload.ip,
            port: payload.port,
            session_id: payload.sessionId,
            token: payload.token,
            expires_at: payload.expiresAt,
            status: "pending",
          },
          nowUnixSeconds,
        ),
      },
    },
  };
};
