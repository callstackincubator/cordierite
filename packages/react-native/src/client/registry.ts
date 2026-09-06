import type { ToolDescriptor } from "@cordierite/shared";

import type {
  CordieriteRegisteredTool,
  CordieriteRuntimeSchema,
  CordieriteToolHandler,
  CordieriteToolRegistration,
} from "../Cordierite.types";
import { CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS } from "../Cordierite.types";
import { logger } from "../logger";
import { normalizeOptionalToolSchema, toToolDescriptor } from "../schema";

export type RegistryDelta =
  | {
      operation: "upsert";
      tool: ToolDescriptor;
    }
  | {
      operation: "remove";
      name: string;
    };

export type ToolRegistry = {
  entries: Map<string, CordieriteRegisteredTool>;
  registerTool<
    TInputSchema extends CordieriteRuntimeSchema | undefined,
    TOutputSchema extends CordieriteRuntimeSchema | undefined
  >(
    registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>
  ): { remove(): void };
  unregisterTool(name: string): void;
  getDescriptors(): ToolDescriptor[];
};

export type ToolRegistryDeps = {
  defaultTimeoutMs: number;
  onDelta: (delta: RegistryDelta) => void;
};

/**
 * Tool registration table. `registerTool`'s disposer removes only its own registration (compared
 * by a per-call identity, not by name) — fixes the v1 defect where a stale disposer from an
 * earlier `registerTool("foo", …)` call could delete a newer registration under the same name.
 */
export const createToolRegistry = (deps: ToolRegistryDeps): ToolRegistry => {
  const entries = new Map<string, CordieriteRegisteredTool>();

  const registerTool = (
    registration: CordieriteToolRegistration<any, any>
  ): { remove(): void } => {
    const inputSchema = normalizeOptionalToolSchema(
      registration.inputSchema,
      `Tool "${registration.name}" inputSchema`
    );
    const outputSchema = normalizeOptionalToolSchema(
      registration.outputSchema,
      `Tool "${registration.name}" outputSchema`
    );

    const descriptor = toToolDescriptor({
      name: registration.name,
      description: registration.description,
      inputSchema,
      outputSchema,
      annotations: registration.annotations,
    });

    if (entries.has(registration.name)) {
      logger.devWarn(
        `registerTool: "${registration.name}" is already registered; overwriting the previous registration.`
      );
    }

    const id = Symbol(`cordierite-tool:${registration.name}`);

    entries.set(registration.name, {
      id,
      descriptor,
      inputSchema,
      outputSchema,
      handler: registration.handler as CordieriteToolHandler,
      timeoutMs: registration.timeoutMs ?? deps.defaultTimeoutMs,
    });

    logger.debug("registerTool", registration.name);
    deps.onDelta({ operation: "upsert", tool: descriptor });

    return {
      remove: () => {
        const current = entries.get(registration.name);

        // Stale disposer: a newer registration under the same name has replaced this one.
        if (!current || current.id !== id) {
          return;
        }

        logger.debug(
          "unregisterTool (from registerTool disposer)",
          registration.name
        );
        entries.delete(registration.name);
        deps.onDelta({ operation: "remove", name: registration.name });
      },
    };
  };

  const unregisterTool = (name: string): void => {
    if (!entries.has(name)) {
      return;
    }

    logger.debug("unregisterTool", name);
    entries.delete(name);
    deps.onDelta({ operation: "remove", name });
  };

  const getDescriptors = (): ToolDescriptor[] =>
    Array.from(entries.values()).map((entry) => entry.descriptor);

  return { entries, registerTool, unregisterTool, getDescriptors };
};

export { CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS };
