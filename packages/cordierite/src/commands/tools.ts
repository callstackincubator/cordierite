import type { CliResult, ToolDescriptor, ToolsCommandData } from "cordierite-shared";

import { toolError } from "../errors.js";
import { requestHostControlForSession } from "./remote-control.js";

export type ToolsCommandOptions = {
  name?: string;
  sessionId: string;
};

export const handleToolsCommand = (
  options: ToolsCommandOptions,
): Promise<CliResult<ToolsCommandData>> => {
  return requestHostControlForSession<{ tools: ToolDescriptor[] }>(
    options.sessionId,
    "GET",
    "/tools",
  ).then((data) => {
    const selectedTool = options.name ? data.tools.find((tool) => tool.name === options.name) : undefined;

    if (options.name && !selectedTool) {
      throw toolError(`Remote tool "${options.name}" is not registered in the connected app.`, {
        type: "tool_not_found",
      });
    }

    return {
      ok: true,
      data: {
        tools: data.tools,
        selected_tool: selectedTool,
      },
    };
  });
};
