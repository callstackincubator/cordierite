import { isConnectBootstrapPayload } from "@cordierite/shared";

import type {
  CordieriteCloseEvent,
  CordieriteConnectionState,
  CordieriteConnectInput,
  CordieriteModuleEvents,
  CordieriteOutboundMessage,
  CordieriteRegisteredTool,
  CordieriteToolHandler,
  CordieriteToolRegistration,
} from "./Cordierite.types";
import type {
  CordieriteNativeModuleLike,
  CreateCordieriteClientOptions,
} from "./client-types";
import {
  nowUnixSeconds,
  toBootstrapPayload,
  toConnectOptions,
} from "./connect-helpers";
import { logger, maskSessionId } from "./logger";
import { sendOutboundMessage } from "./outbound-send";
import { createRegistrySync } from "./registry-sync";
import { requireOptionalStandardSchema, toToolDescriptor } from "./schema";
import { createToolMessageHandler } from "./tool-invocation";

export type {
  CordieriteNativeModuleLike,
  CreateCordieriteClientOptions,
} from "./client-types";

type EventName = keyof CordieriteModuleEvents;

export const createCordieriteClient = (
  module: CordieriteNativeModuleLike,
  clientOptions: CreateCordieriteClientOptions = {}
) => {
  let currentSessionId: string | null = null;
  const registry = new Map<string, CordieriteRegisteredTool>();

  const resetSession = () => {
    currentSessionId = null;
  };

  const getSessionId = () => currentSessionId;

  const { syncRegistrySnapshot, syncRegistryDelta } = createRegistrySync({
    getState: () => module.getState(),
    getSessionId,
    getRegistry: () => registry,
    sendWire: (json) => module.send(json),
  });

  const invokeRegisteredTool = createToolMessageHandler({
    getSessionId,
    getRegistry: () => registry,
    sendWire: (json) => module.send(json),
  });

  module.addListener("close", (event: CordieriteCloseEvent) => {
    logger.debug("connection closed", event);
    resetSession();
  });
  module.addListener("error", (event) => {
    logger.warn("connection error", {
      code: event.code,
      message: event.message,
      phase: event.phase,
      nativeCode: event.nativeCode,
      closeReason: event.closeReason,
      isRetryable: event.isRetryable,
      hint: event.hint,
    });
    resetSession();
  });
  module.addListener("stateChange", (event) => {
    logger.debug("state", event.state);
    if (event.state === "active") {
      void syncRegistrySnapshot();
    }
  });
  module.addListener("message", (event) => {
    void invokeRegisteredTool(event.message);
  });

  return {
    /**
     * Starts the Cordierite session handshake. Resolves when native `connect` has accepted
     * options and begun connecting — not when `getState()` is already `"active"`.
     * Wait for `stateChange` to `"active"` before calling `send`.
     */
    async connect(input: CordieriteConnectInput): Promise<void> {
      const options = toConnectOptions(input, clientOptions);

      const isValid = isConnectBootstrapPayload(toBootstrapPayload(options), {
        now: nowUnixSeconds(),
      });

      if (!isValid) {
        logger.debug("connect rejected: invalid or expired bootstrap payload");
        throw new Error("Invalid or expired Cordierite bootstrap payload.");
      }

      const state = module.getState();

      if (state === "connecting" || state === "active") {
        logger.debug("connect rejected: already", state);
        throw new Error(
          "A Cordierite session is already connecting or active."
        );
      }

      logger.debug("connect", {
        host: `${options.ip}:${options.port}`,
        session: maskSessionId(options.sessionId),
      });

      currentSessionId = options.sessionId;
      try {
        await module.connect(options);
      } catch (error) {
        resetSession();
        throw error;
      }
    },

    async send(message: CordieriteOutboundMessage): Promise<void> {
      await sendOutboundMessage(
        {
          getState: () => module.getState(),
          getSessionId,
          sendRaw: (jsonString) => module.send(jsonString),
        },
        message
      );
    },

    async close(): Promise<void> {
      logger.debug("close");
      resetSession();
      await module.close();
    },

    getState(): CordieriteConnectionState {
      return module.getState();
    },

    addListener<Event extends EventName>(
      eventName: Event,
      listener: CordieriteModuleEvents[Event]
    ) {
      return module.addListener(eventName, listener);
    },

    registerTool<
      TInputSchema extends
        | import("@cordierite/shared").StandardSchemaV1
        | undefined,
      TOutputSchema extends
        | import("@cordierite/shared").StandardSchemaV1
        | undefined
    >(
      registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>
    ) {
      const inputSchema = requireOptionalStandardSchema(
        registration.inputSchema,
        `Tool "${registration.name}" inputSchema`
      );
      const outputSchema = requireOptionalStandardSchema(
        registration.outputSchema,
        `Tool "${registration.name}" outputSchema`
      );

      const normalizedDescriptor = toToolDescriptor({
        name: registration.name,
        description: registration.description,
        inputSchema,
        outputSchema,
      });

      logger.debug("registerTool", registration.name);
      registry.set(registration.name, {
        descriptor: normalizedDescriptor,
        inputSchema,
        outputSchema,
        handler: registration.handler as CordieriteToolHandler,
      });

      void syncRegistryDelta({
        operation: "upsert",
        tool: normalizedDescriptor,
      });

      return {
        remove: () => {
          logger.debug(
            "unregisterTool (from registerTool disposer)",
            registration.name
          );
          registry.delete(registration.name);
          void syncRegistryDelta({
            operation: "remove",
            name: registration.name,
          });
        },
      };
    },

    unregisterTool(name: string): void {
      if (!registry.has(name)) {
        return;
      }

      logger.debug("unregisterTool", name);
      registry.delete(name);
      void syncRegistryDelta({
        operation: "remove",
        name,
      });
    },

    getRegisteredTools() {
      return Array.from(registry.values()).map((entry) => entry.descriptor);
    },
  };
};
