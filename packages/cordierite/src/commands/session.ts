import type { CliResult, SessionCommandData, SessionListItem } from "@cordierite/shared";

import { usageError } from "../errors.js";
import {
  isValidOpaqueSessionId,
  listAndPruneSessionRegistryEntries,
  resolveSessionRegistryEntry,
} from "../session-registry.js";
import type { CordieriteSessionRegistryEntry } from "../session-registry.js";
import { requestHostControlForSession } from "./remote-control.js";

const registryToListItem = (entry: CordieriteSessionRegistryEntry): SessionListItem => ({
  session_id: entry.sessionId,
  status: entry.status,
  control_port: entry.controlPort,
  wss_port: entry.wssPort,
  endpoint: entry.endpoint,
  tool_count: entry.remoteTools.length,
});

export type SessionCommandOptions = {
  sessionId?: string;
};

export const handleSessionCommand = async (
  options: SessionCommandOptions = {},
): Promise<CliResult<SessionCommandData>> => {
  const entries = await listAndPruneSessionRegistryEntries();
  const sessions = entries.map(registryToListItem);

  if (options.sessionId === undefined) {
    return {
      ok: true,
      data: {
        sessions,
      },
    };
  }

  if (options.sessionId.length === 0) {
    throw usageError("The session command requires a non-empty --session-id when provided.");
  }

  if (!isValidOpaqueSessionId(options.sessionId)) {
    throw usageError(
      "The --session-id must be the opaque session id from the host (16–128 chars: letters, digits, _ or -).",
    );
  }

  const entry = await resolveSessionRegistryEntry(options.sessionId);

  const live = await requestHostControlForSession<{
    status: "none" | "active";
    session_id?: string;
    endpoint?: { ip: string; port: number; url: string };
  }>(options.sessionId, "GET", "/session");

  const selected: SessionListItem = {
    session_id: entry.sessionId,
    status:
      live.status === "active"
        ? "active"
        : entry.status === "pending"
          ? "pending"
          : "none",
    control_port: entry.controlPort,
    wss_port: entry.wssPort,
    endpoint: live.status === "active" && live.endpoint ? live.endpoint : entry.endpoint,
    tool_count: entry.remoteTools.length,
  };

  return {
    ok: true,
    data: {
      sessions,
      selected,
    },
  };
};
