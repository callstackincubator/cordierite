/**
 * `cordierite tools` (ARCHITECTURE.md §10): `tools [selector] [--full]` lists tools for a session;
 * `tools [selector] <name>` shows one tool's full schema/annotations.
 *
 * The command table gives both forms a leading optional `[selector]`, which makes a single
 * positional argument inherently ambiguous (is it the selector, or the tool name in `tools <name>`
 * with the selector omitted?). This resolves it the same way a human reading the table would:
 * first try the arg as a tool name in the implicit-selector session's registry; if no such tool
 * exists there (or the implicit selector doesn't resolve, e.g. `ambiguous_session`), fall back to
 * treating it as a selector and list that session's tools instead.
 */

import { RPC_METHODS, type ToolDescriptor, type ToolsListResult } from "@cordierite/shared";

import type { CliResult, ToolsCommandData } from "../cli/result-types.js";
import { usageError } from "../errors.js";
import { callDaemon, DaemonRpcError, type SpawnFn } from "../rpc/client.js";

export type ToolsCommandOptions = {
  selector?: string;
  name?: string;
};

export type ToolsCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
};

const listTools = (
  selector: string | undefined,
  context: ToolsCommandContext,
): Promise<ToolsListResult> => {
  return callDaemon<ToolsListResult>(
    RPC_METHODS.toolsList,
    { selector },
    { stateDir: context.stateDir, spawn: context.spawn },
  );
};

const findTool = (tools: ToolDescriptor[], name: string): ToolDescriptor | undefined => {
  return tools.find((tool) => tool.name === name);
};

export const handleToolsCommand = async (
  options: ToolsCommandOptions,
  context: ToolsCommandContext,
): Promise<CliResult<ToolsCommandData>> => {
  if (options.selector !== undefined && options.name !== undefined) {
    const tools = await listTools(options.selector, context);
    const tool = findTool(tools, options.name);

    if (!tool) {
      throw usageError(
        `Tool "${options.name}" is not registered on session "${options.selector}".`,
        { available: tools.map((entry) => entry.name) },
      );
    }

    return { ok: true, data: tool };
  }

  if (options.selector !== undefined) {
    // A single positional arg: try it as the implicit session's tool name first.
    let implicitTools: ToolsListResult | undefined;

    try {
      implicitTools = await listTools(undefined, context);
    } catch (error) {
      if (!(error instanceof DaemonRpcError)) {
        throw error;
      }
    }

    if (implicitTools) {
      const tool = findTool(implicitTools, options.selector);

      if (tool) {
        return { ok: true, data: tool };
      }
    }

    // Not a tool name on the implicit session (or there is no implicit session): treat the arg as
    // a selector and list that session's tools instead.
    return { ok: true, data: await listTools(options.selector, context) };
  }

  return { ok: true, data: await listTools(undefined, context) };
};
