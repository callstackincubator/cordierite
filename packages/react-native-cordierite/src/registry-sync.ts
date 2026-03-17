import type { ToolDescriptor } from "cordierite-shared";

import type {
  CordieriteConnectionState,
  CordieriteRegisteredTool,
} from "./Cordierite.types";

export type RegistryDelta =
  | {
      operation: "upsert";
      tool: ToolDescriptor;
    }
  | {
      operation: "remove";
      name: string;
    };

export type RegistrySyncDeps = {
  getState: () => CordieriteConnectionState;
  getSessionId: () => string | null;
  getRegistry: () => Map<string, CordieriteRegisteredTool>;
  sendWire: (json: string) => Promise<void>;
};

export const createRegistrySync = (deps: RegistrySyncDeps) => {
  const { getState, getSessionId, getRegistry, sendWire } = deps;

  const syncRegistrySnapshot = async () => {
    if (getState() !== "active" || !getSessionId()) {
      return;
    }

    const sessionId = getSessionId()!;
    await sendWire(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: sessionId,
        tools: Array.from(getRegistry().values()).map(
          (entry) => entry.descriptor
        ),
      })
    );
  };

  const syncRegistryDelta = async (delta: RegistryDelta) => {
    if (getState() !== "active" || !getSessionId()) {
      return;
    }

    const sessionId = getSessionId()!;
    await sendWire(
      JSON.stringify({
        type: "tool_registry_delta",
        session_id: sessionId,
        ...delta,
      })
    );
  };

  return { syncRegistrySnapshot, syncRegistryDelta };
};
