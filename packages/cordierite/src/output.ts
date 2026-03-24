import pc from "picocolors";
import type {
  CliError,
  CliResult,
  CommandMeta,
  ConnectCommandData,
  HostCommandData,
  InvokeCommandData,
  SessionCommandData,
  ToolDescriptor,
  ToolsCommandData,
} from "@cordierite/shared";

type ColorPalette = ReturnType<typeof pc.createColors>;

export type RenderOptions = {
  command: string;
  json: boolean;
  color: boolean;
};

const indentJson = (value: unknown): string => {
  return JSON.stringify(value, null, 2);
};

const renderMetaLines = (meta?: CommandMeta): string[] => {
  if (!meta) {
    return [];
  }

  return [
    "Meta",
    `  Command: ${meta.command}`,
    `  Timestamp: ${meta.timestamp}`,
    ...(typeof meta.duration_ms === "number" ? [`  Duration: ${meta.duration_ms} ms`] : []),
  ];
};

const formatScalar = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null || value === undefined) {
    return "null";
  }

  return indentJson(value);
};

const formatTtlSeconds = (ttlSeconds: number): string => {
  return `${ttlSeconds}s`;
};

const renderFields = (title: string, fields: Array<[label: string, value: unknown]>): string[] => {
  const visibleFields = fields.filter(([, value]) => value !== undefined);

  if (visibleFields.length === 0) {
    return [];
  }

  const width = Math.max(...visibleFields.map(([label]) => label.length));

  return [
    title,
    ...visibleFields.map(([label, value]) => `  ${label.padEnd(width)}  ${formatScalar(value)}`),
  ];
};

const renderToolTable = (tools: ToolDescriptor[]): string[] => {
  if (tools.length === 0) {
    return ["Tools", "  No tools registered."];
  }

  const nameWidth = Math.max(...tools.map((tool) => tool.name.length), "Name".length);

  return [
    "Tools",
    `  ${"Name".padEnd(nameWidth)}  Description`,
    ...tools.map((tool) => `  ${tool.name.padEnd(nameWidth)}  ${tool.description}`),
  ];
};

const renderConnectData = (colors: ColorPalette, data: ConnectCommandData): string[] => {
  return [
    colors.green("Connection Ready"),
    ...renderFields("Bootstrap", [
      ["Session", data.bootstrap.session_id],
      ["URL", data.bootstrap.endpoint.url],
      ["Expires", data.bootstrap.expires_at_iso],
      ["Claimable", data.bootstrap.can_claim],
    ]),
  ];
};

const renderSessionListItem = (item: SessionCommandData["sessions"][number]): string[] => {
  return renderFields("Entry", [
    ["Session", item.session_id],
    ["State", item.status],
    ["Control port", item.control_port],
    ["WSS port", item.wss_port],
    ["URL", item.endpoint?.url],
    ["Tools", item.tool_count],
  ]);
};

const renderSessionData = (colors: ColorPalette, data: SessionCommandData): string[] => {
  const lines: string[] = [];

  if (data.sessions.length === 0) {
    lines.push(colors.dim("Sessions"), "  No Cordierite host sessions are registered.");
  } else {
    lines.push(colors.green("Sessions"));
    for (const session of data.sessions) {
      lines.push("");
      lines.push(...renderSessionListItem(session));
    }
  }

  if (data.selected) {
    lines.push("", colors.green("Selected session"), ...renderSessionListItem(data.selected));
  }

  return lines;
};

const renderToolsData = (colors: ColorPalette, data: ToolsCommandData): string[] => {
  return [
    colors.green("Available Tools"),
    ...renderToolTable(data.tools),
    ...(!data.selected_tool
      ? []
      : [
          "",
          ...renderFields("Selected Tool", [
            ["Name", data.selected_tool.name],
            ["Description", data.selected_tool.description],
            ["Input Schema", data.selected_tool.input_schema],
            ["Output Schema", data.selected_tool.output_schema],
          ]),
        ]),
  ];
};

const renderInvokeData = (colors: ColorPalette, data: InvokeCommandData): string[] => {
  return [
    colors.green("Invocation Complete"),
    ...renderFields("Result", [
      ["Tool", data.invocation.tool],
      ["Payload", data.invocation.result],
    ]),
  ];
};

const renderHostData = (colors: ColorPalette, data: HostCommandData): string[] => {
  return [
    colors.green("Host Ready"),
    ...renderFields("Host", [
      ["Fingerprint", data.host.spki_pin],
      ["Session", data.host.session_id],
      ["WSS port", data.host.wss_port],
      ["Control port", data.host.control_port],
      ["Deep Link", data.host.deep_link],
      ["TTL", formatTtlSeconds(data.host.ttl_seconds)],
    ]),
  ];
};

const renderSuccessData = (
  colors: ColorPalette,
  command: string,
  data:
    | HostCommandData
    | ConnectCommandData
    | SessionCommandData
    | ToolsCommandData
    | InvokeCommandData,
): string[] => {
  switch (command) {
    case "host":
      return renderHostData(colors, data as HostCommandData);
    case "connect":
      return renderConnectData(colors, data as ConnectCommandData);
    case "session":
      return renderSessionData(colors, data as SessionCommandData);
    case "tools":
      return renderToolsData(colors, data as ToolsCommandData);
    case "invoke":
      return renderInvokeData(colors, data as InvokeCommandData);
    default:
      return [colors.green("Command Complete"), indentJson(data)];
  }
};

const renderHumanError = (colors: ColorPalette, error: CliError, meta?: CommandMeta): string => {
  return [
    colors.red("Command Failed"),
    ...renderFields("Error", [
      ["Type", error.type],
      ["Message", error.message],
      ["Details", error.details],
    ]),
    ...(meta ? ["", ...renderMetaLines(meta)] : []),
  ].join("\n");
};

export const renderResult = (
  result: CliResult<unknown>,
  options: RenderOptions,
): {
  stdout?: string;
  stderr?: string;
} => {
  if (options.json) {
    return {
      stdout: `${indentJson(result)}\n`,
    };
  }

  const colors = pc.createColors(options.color);

  if (!result.ok) {
    return {
      stderr: `${renderHumanError(colors, result.error, result.meta)}\n`,
    };
  }

  const lines = [
    ...renderSuccessData(colors, options.command, result.data as never),
    "",
    ...renderMetaLines(result.meta),
  ].filter((line, index, collection) => {
    if (line !== "") {
      return true;
    }

    return index > 0 && collection[index - 1] !== "" && index < collection.length - 1;
  });

  return {
    stdout: `${lines.join("\n")}\n`,
  };
};
