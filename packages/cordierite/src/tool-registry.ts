import type { ToolDescriptor } from "cordierite-shared";

import { toolError } from "./errors.js";

export type ToolExecutionContext = {
  now: () => Date;
};

export type ToolDefinition = {
  descriptor: ToolDescriptor;
  execute: (input: Record<string, unknown>, context: ToolExecutionContext) => unknown;
};

export const builtinTools: ToolDefinition[] = [
  {
    descriptor: {
      name: "ping",
      description: "Return a simple heartbeat payload for connectivity checks.",
      input_schema: {},
      output_schema: {
        pong: "boolean",
        timestamp: "string",
      },
    },
    execute: (_input, context) => {
      return {
        pong: true,
        timestamp: context.now().toISOString(),
      };
    },
  },
  {
    descriptor: {
      name: "echo",
      description: "Echo the provided input payload to validate invocation wiring.",
      input_schema: {
        value: "unknown",
      },
      output_schema: {
        echoed: "unknown",
      },
    },
    execute: (input) => {
      return {
        echoed: input,
      };
    },
  },
  {
    descriptor: {
      name: "handshake.inspect",
      description: "Summarize the current handshake call format for debugging.",
      input_schema: {
        session_id: "string?",
      },
      output_schema: {
        transport: "wss",
        message_type: "tool_call",
        session_id: "string | null",
      },
    },
    execute: (input) => {
      const sessionId = typeof input.session_id === "string" ? input.session_id : null;

      return {
        transport: "wss",
        message_type: "tool_call",
        session_id: sessionId,
      };
    },
  },
  {
    descriptor: {
      name: "fail",
      description: "Simulate a deterministic tool failure for testing and diagnostics.",
      input_schema: {},
      output_schema: {
        error: "never",
      },
    },
    execute: () => {
      throw toolError("The requested tool reported a simulated failure.");
    },
  },
];

export const getToolDescriptors = (registry: ToolDefinition[] = builtinTools): ToolDescriptor[] => {
  return registry.map((tool) => tool.descriptor);
};

export const findTool = (
  name: string,
  registry: ToolDefinition[] = builtinTools,
): ToolDefinition | undefined => {
  return registry.find((tool) => tool.descriptor.name === name);
};

export const requireTool = (name: string, registry: ToolDefinition[] = builtinTools): ToolDefinition => {
  const tool = findTool(name, registry);

  if (!tool) {
    throw toolError(`Unknown tool "${name}".`, {
      available_tools: registry.map((entry) => entry.descriptor.name),
    });
  }

  return tool;
};
