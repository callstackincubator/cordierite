import pc from "picocolors";
import { formatAgentWebSocketUrl, type EventNotification, type SessionSummary, type ToolDescriptor } from "@cordierite/shared";

import type {
  CliError,
  CliResult,
  CommandMeta,
  DaemonRunCommandData,
  DaemonStartCommandData,
  DaemonStatusCommandData,
  DaemonStopCommandData,
  DoctorCommandData,
  InitCommandData,
  InvokeCommandData,
  KeygenCommandData,
  LinkCommandData,
  LsCommandData,
  RevokeCommandData,
  ToolsCommandData,
} from "./cli/result-types.js";
import { renderQrToTerminal } from "./qr-terminal.js";

type ColorPalette = ReturnType<typeof pc.createColors>;

export type RenderOptions = {
  command: string;
  json: boolean;
  color: boolean;
  /** `link`-only: also render the deep link as terminal QR art (never affects `--json` output). */
  qr?: boolean;
  /** `tools`-only: render full schemas/annotations for every listed tool, not just name+description. */
  full?: boolean;
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

/** Humanizes an elapsed duration for `ls`'s "age" column: seconds/minutes/hours/days, coarsest unit
 * that keeps at least one digit of precision. */
const formatAge = (fromIso: string, toIso: string): string => {
  const elapsedMs = Math.max(0, new Date(toIso).getTime() - new Date(fromIso).getTime());
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }

  return `${Math.floor(elapsedHours / 24)}d`;
};

const formatDevice = (device: SessionSummary["device"]): string => {
  const parts = [device.manufacturer, device.model].filter((part): part is string => Boolean(part));
  const label = parts.length > 0 ? parts.join(" ") : "unknown device";
  return device.os ? `${label} (${device.os})` : label;
};

const renderLsData = (colors: ColorPalette, data: LsCommandData, meta?: CommandMeta): string[] => {
  if (data.length === 0) {
    return [colors.dim("Sessions"), "  No Cordierite sessions are registered."];
  }

  const now = meta?.timestamp ?? new Date().toISOString();
  const headers = ["Alias", "State", "Device", "Tools", "Age"] as const;
  const rows = data.map((session) => [
    session.alias,
    session.state,
    formatDevice(session.device),
    String(session.toolCount),
    formatAge(session.claimedAt ?? session.createdAt, now),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );

  return [
    colors.green("Sessions"),
    `  ${headers.map((header, index) => header.padEnd(widths[index]!)).join("  ")}`,
    ...rows.map((row) => `  ${row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ")}`),
  ];
};

const renderToolSummaryTable = (tools: ToolDescriptor[]): string[] => {
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

const renderToolDetail = (colors: ColorPalette, tool: ToolDescriptor): string[] => {
  return renderFields(colors.green(`Tool: ${tool.name}`), [
    ["Description", tool.description],
    ["Input schema", tool.input_schema],
    ["Output schema", tool.output_schema],
    ["Annotations", tool.annotations],
    // Only rendered for a tool that declares one; `renderFields` drops undefined rows, so a tool
    // on the daemon's default deadline shows no line at all rather than a misleading "10000".
    ["Timeout (ms)", tool.timeout_ms],
  ]);
};

const renderToolsData = (colors: ColorPalette, data: ToolsCommandData, full?: boolean): string[] => {
  if (!Array.isArray(data)) {
    return renderToolDetail(colors, data);
  }

  if (full) {
    return data.length === 0
      ? ["Tools", "  No tools registered."]
      : data.flatMap((tool, index) => [...(index > 0 ? [""] : []), ...renderToolDetail(colors, tool)]);
  }

  return [colors.green("Tools"), ...renderToolSummaryTable(data).slice(1)];
};

const renderInvokeData = (colors: ColorPalette, data: InvokeCommandData): string[] => {
  return [colors.green("Result"), formatScalar(data)];
};

const renderLinkData = (colors: ColorPalette, data: LinkCommandData, qr?: boolean): string[] => {
  const lines = [
    colors.green("Link Created"),
    ...renderFields("Link", [
      ["Session", data.sessionId],
      ["Deep link", data.deepLink],
      ["Endpoint", formatAgentWebSocketUrl(data.endpoint)],
      ["Pin", data.pin],
      ["Expires", new Date(data.expiresAt * 1000).toISOString()],
      ["Delivered", data.delivered ? `yes (${data.target})` : undefined],
    ]),
  ];

  if (qr) {
    lines.push("", "QR", renderQrToTerminal(data.deepLink));
  }

  return lines;
};

const renderRevokeData = (colors: ColorPalette, _data: RevokeCommandData): string[] => {
  return [colors.green("Session Revoked")];
};

const renderKeygenData = (colors: ColorPalette, data: KeygenCommandData): string[] => {
  return [
    colors.green("Key Ready"),
    ...renderFields("Key", [
      ["Path", data.path],
      ["Fingerprint", data.pin],
    ]),
  ];
};

const renderInitData = (colors: ColorPalette, data: InitCommandData): string[] => {
  const snippet = JSON.stringify(
    { mcpServers: { cordierite: data.mcpServerEntry } },
    null,
    2,
  );

  return [
    colors.green(data.changed ? "Project Initialized" : "Project Already Initialized"),
    ...renderFields("Config", [
      ["Path", data.path],
      ["Scheme", data.scheme],
      ["Source", data.source],
      ["Written", data.changed ? (data.created ? "created" : "updated") : "unchanged"],
    ]),
    ...(data.note === undefined ? [] : ["", colors.yellow(`Note: ${data.note}`)]),
    "",
    "MCP server entry",
    ...snippet.split("\n").map((line) => `  ${line}`),
    "",
    "Next",
    ...data.nextSteps.map((step, index) => `  ${index + 1}. ${step}`),
  ];
};

const renderDaemonRunData = (colors: ColorPalette, data: DaemonRunCommandData): string[] => {
  return [
    colors.green("Daemon Running"),
    ...renderFields("Daemon", [
      ["PID", data.daemon.pid],
      ["State dir", data.daemon.state_dir],
      ["Socket", data.daemon.socket_path],
    ]),
  ];
};

const renderDaemonStartData = (colors: ColorPalette, data: DaemonStartCommandData): string[] => {
  return [
    colors.green("Daemon Started"),
    ...renderFields("Daemon", [
      ["PID", data.daemon.pid],
      ["WSS port", data.daemon.wss_port],
      ["Started at", data.daemon.started_at],
    ]),
  ];
};

const renderDaemonStopData = (colors: ColorPalette, data: DaemonStopCommandData): string[] => {
  return [
    colors.green("Daemon Stopped"),
    ...renderFields("Daemon", [["Method", data.daemon.method]]),
  ];
};

/** Human column for a byte count (the machine-readable `bytes` stays exact in `--json`). Binary
 * units, one decimal above KiB, so a growing `audit/` reads at a glance. */
const formatByteSize = (bytes: number): string => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];

  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

const renderDaemonStatusData = (colors: ColorPalette, data: DaemonStatusCommandData): string[] => {
  return [
    colors.green("Daemon Status"),
    ...renderFields("Daemon", [
      ["Version", data.daemon.version],
      ["PID", data.daemon.pid],
      ["Started at", data.daemon.started_at],
      ["WSS port", data.daemon.wss_port],
      ["Pinned keys", data.daemon.pinned_keys.length],
      ["Sessions", data.daemon.session_count],
    ]),
    "",
    ...renderFields("Policy", [
      ["Default", data.policy.default],
      ["Destructive", data.policy.destructive],
      ["Overrides", data.policy.tools ? Object.keys(data.policy.tools).length : 0],
    ]),
    "",
    // The retention rows drop out entirely against a daemon that predates them (`renderFields`
    // skips `undefined`), rather than printing "undefined" or an invented zero.
    ...renderFields("Audit", [
      ["Path", data.audit.path],
      ["Retention", data.audit.retention_days === undefined ? undefined : `${data.audit.retention_days} days`],
      ["Files", data.audit.files],
      ["Size", data.audit.bytes === undefined ? undefined : formatByteSize(data.audit.bytes)],
      ["Failed writes", data.audit.failed_writes],
      ["Failed prunes", data.audit.failed_prunes],
    ]),
    // Version drift (issue #30) is the one thing here an operator has to act on, so it goes last
    // — the line still on screen after the block scrolls — and in yellow, not a quiet field row.
    ...(data.warning ? ["", colors.yellow(`Warning: ${data.warning}`)] : []),
  ];
};

const renderDoctorData = (colors: ColorPalette, data: DoctorCommandData): string[] => {
  return [
    data.present ? colors.green("Cordierite Present") : colors.yellow("Cordierite Absent"),
    ...renderFields("Artifact", [
      ["Path", data.artifact],
      ["Platform", data.platform],
      ["Format", data.format],
      ["Present", data.present],
      ["Signals", data.signals.length > 0 ? data.signals.join(", ") : "none"],
      ["Assertion", data.assertion ? `${data.assertion.expected} (holds)` : undefined],
    ]),
  ];
};

const renderSuccessData = (
  colors: ColorPalette,
  command: string,
  data: unknown,
  options: RenderOptions,
  meta?: CommandMeta,
): string[] => {
  switch (command) {
    case "init":
      return renderInitData(colors, data as InitCommandData);
    case "keygen":
      return renderKeygenData(colors, data as KeygenCommandData);
    case "link":
      return renderLinkData(colors, data as LinkCommandData, options.qr);
    case "ls":
      return renderLsData(colors, data as LsCommandData, meta);
    case "tools":
      return renderToolsData(colors, data as ToolsCommandData, options.full);
    case "invoke":
      return renderInvokeData(colors, data as InvokeCommandData);
    case "revoke":
      return renderRevokeData(colors, data as RevokeCommandData);
    case "daemon run":
      return renderDaemonRunData(colors, data as DaemonRunCommandData);
    case "daemon start":
      return renderDaemonStartData(colors, data as DaemonStartCommandData);
    case "daemon stop":
      return renderDaemonStopData(colors, data as DaemonStopCommandData);
    case "daemon status":
      return renderDaemonStatusData(colors, data as DaemonStatusCommandData);
    case "doctor":
      return renderDoctorData(colors, data as DoctorCommandData);
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
    ...renderSuccessData(colors, options.command, result.data, options, result.meta),
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

/** Renders one `cordierite events` line: NDJSON under `--json`, a compact human line otherwise. */
export const renderEventLine = (
  event: EventNotification,
  options: { json: boolean; color: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(event);
  }

  const colors = pc.createColors(options.color);
  const timestamp = new Date(event.ts).toISOString();
  const target = event.alias ?? event.sessionId;
  const dataSuffix = event.data === undefined ? "" : ` ${indentJson(event.data)}`;

  return `${colors.dim(timestamp)} ${colors.green(event.kind)}${target ? ` ${target}` : ""}${dataSuffix}`;
};

/** Renders the trailing cursor line for `cordierite events --since` (issue #6): NDJSON under
 * `--json` so a scripted caller can parse the resume point without maxing `seq` over the printed
 * events (impossible when the response is empty), a human note otherwise. */
export const renderEventsCursorLine = (cursor: number, options: { json: boolean; color: boolean }): string => {
  if (options.json) {
    return JSON.stringify({ cursor });
  }

  const colors = pc.createColors(options.color);
  return colors.dim(`cursor: ${cursor} (pass --since ${cursor} to resume from here)`);
};
