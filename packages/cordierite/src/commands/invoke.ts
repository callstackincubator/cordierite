import type { CliResult, InvokeCommandData } from "@cordierite/shared";

import { parseJsonObject } from "../parse.js";
import { requestHostControlForSession } from "./remote-control.js";

export type InvokeCommandOptions = {
  name: string;
  input?: string;
  sessionId: string;
};

export const handleInvokeCommand = (
  options: InvokeCommandOptions,
): Promise<CliResult<InvokeCommandData>> => {
  const input = options.input ? parseJsonObject(options.input, "--input") : {};

  return requestHostControlForSession<{
    tool: string;
    result: unknown;
  }>(options.sessionId, "POST", "/call", {
    name: options.name,
    args: input,
  }).then((result) => {
    return {
      ok: true,
      data: {
        invocation: {
          tool: result.tool,
          result: result.result,
        },
      },
    };
  });
};
