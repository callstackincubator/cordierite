/**
 * `config.json` loading and validation (ARCHITECTURE.md §3). All fields are optional; unknown
 * top-level keys produce a warning (not an error); invalid values throw a clear error naming the
 * offending key.
 */

import { readFile } from "node:fs/promises";

import type { StateDirPaths } from "./state-dir.js";

export type PolicyDecision = "allow" | "deny" | "prompt";

/**
 * `config.json`'s `policy` shape (ARCHITECTURE.md §12): `default` applies to tools whose
 * descriptor has no `annotations.destructiveHint`; `destructive` applies when it is `true`;
 * `tools["<alias>/<name>"]` overrides both for one specific tool on one specific session alias.
 * `"prompt"` means "a human gate is required; if one cannot be guaranteed, deny" — today the only
 * such gate is an MCP client that honors `_meta["anthropic/requiresUserInteraction"]`
 * (ARCHITECTURE.md §9/§12); every other caller (CLI, a non-compliant MCP client) gets
 * `policy_denied` with reason `no_consent_channel`.
 */
export type CordieritePolicyConfig = {
  default: PolicyDecision;
  destructive: PolicyDecision;
  tools?: Record<string, PolicyDecision>;
};

export type CordieriteConfig = {
  wssPort: number;
  keyPath: string;
  graceSeconds: number;
  linkTtlSeconds: number;
  keepaliveIntervalSeconds: number;
  policy: CordieritePolicyConfig;
  /** Operator override for advertised-address detection (daemon/address.ts); undefined = auto-detect. */
  advertisedIp?: string;
  /**
   * Deep-link URI scheme used to compose `cordierite link`'s output (ARCHITECTURE.md §10: "taken
   * from the flag, else `config.json`, else the CLI errors with a clear message"). Not part of the
   * `config.json` shape enumerated in ARCHITECTURE.md §3 (which only covers daemon-side settings),
   * but `config.json` is explicitly "all fields optional" there and this is the natural home for a
   * CLI-side setting an operator wants to set once rather than pass with every `link` invocation.
   */
  scheme?: string;
};

const KNOWN_TOP_LEVEL_KEYS = new Set<string>([
  "wssPort",
  "keyPath",
  "graceSeconds",
  "linkTtlSeconds",
  "keepaliveIntervalSeconds",
  "policy",
  "advertisedIp",
  "scheme",
]);

const KNOWN_POLICY_KEYS = new Set<string>(["default", "destructive", "tools"]);

const POLICY_DECISIONS = new Set<string>(["allow", "deny", "prompt"]);

export class CordieriteConfigError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "CordieriteConfigError";
  }
}

const configError = (key: string, message: string): CordieriteConfigError => {
  return new CordieriteConfigError(key, `Invalid Cordierite config value for "${key}": ${message}`);
};

const requirePositiveInteger = (value: unknown, key: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw configError(key, "must be a positive integer.");
  }

  return value;
};

const requireNonEmptyString = (value: unknown, key: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw configError(key, "must be a non-empty string.");
  }

  return value;
};

const requirePolicyDecision = (value: unknown, key: string): PolicyDecision => {
  if (typeof value !== "string" || !POLICY_DECISIONS.has(value)) {
    throw configError(key, 'must be "allow", "deny", or "prompt".');
  }

  return value as PolicyDecision;
};

export const defaultConfig = (paths: StateDirPaths): CordieriteConfig => {
  return {
    wssPort: 8443,
    keyPath: paths.keyPath,
    graceSeconds: 600,
    linkTtlSeconds: 300,
    keepaliveIntervalSeconds: 15,
    policy: {
      default: "allow",
      destructive: "allow",
    },
  };
};

export type ConfigWarnFn = (message: string) => void;

/** Loads and validates `<state-dir>/config.json`, falling back to defaults when it is missing. */
export const loadConfig = async (
  paths: StateDirPaths,
  options: { warn?: ConfigWarnFn } = {},
): Promise<CordieriteConfig> => {
  const warn = options.warn ?? (() => {});
  const config = defaultConfig(paths);

  let raw: unknown;

  try {
    raw = JSON.parse(await readFile(paths.configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return config;
    }

    throw configError("config.json", `could not be read/parsed (${(error as Error).message}).`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw configError("config.json", "must be a JSON object.");
  }

  const parsed = raw as Record<string, unknown>;

  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warn(`Unknown Cordierite config key "${key}" is ignored.`);
    }
  }

  if (parsed.wssPort !== undefined) {
    config.wssPort = requirePositiveInteger(parsed.wssPort, "wssPort");
  }

  if (parsed.keyPath !== undefined) {
    config.keyPath = requireNonEmptyString(parsed.keyPath, "keyPath");
  }

  if (parsed.advertisedIp !== undefined) {
    config.advertisedIp = requireNonEmptyString(parsed.advertisedIp, "advertisedIp");
  }

  if (parsed.scheme !== undefined) {
    config.scheme = requireNonEmptyString(parsed.scheme, "scheme");
  }

  if (parsed.graceSeconds !== undefined) {
    config.graceSeconds = requirePositiveInteger(parsed.graceSeconds, "graceSeconds");
  }

  if (parsed.linkTtlSeconds !== undefined) {
    config.linkTtlSeconds = requirePositiveInteger(parsed.linkTtlSeconds, "linkTtlSeconds");
  }

  if (parsed.keepaliveIntervalSeconds !== undefined) {
    config.keepaliveIntervalSeconds = requirePositiveInteger(
      parsed.keepaliveIntervalSeconds,
      "keepaliveIntervalSeconds",
    );
  }

  if (parsed.policy !== undefined) {
    if (typeof parsed.policy !== "object" || parsed.policy === null || Array.isArray(parsed.policy)) {
      throw configError("policy", "must be an object.");
    }

    const policy = parsed.policy as Record<string, unknown>;

    for (const key of Object.keys(policy)) {
      if (!KNOWN_POLICY_KEYS.has(key)) {
        warn(`Unknown Cordierite config key "policy.${key}" is ignored.`);
      }
    }

    if (policy.default !== undefined) {
      config.policy.default = requirePolicyDecision(policy.default, "policy.default");
    }

    if (policy.destructive !== undefined) {
      config.policy.destructive = requirePolicyDecision(policy.destructive, "policy.destructive");
    }

    if (policy.tools !== undefined) {
      if (typeof policy.tools !== "object" || policy.tools === null || Array.isArray(policy.tools)) {
        throw configError("policy.tools", "must be an object.");
      }

      const tools: Record<string, PolicyDecision> = {};

      for (const [toolKey, toolValue] of Object.entries(policy.tools as Record<string, unknown>)) {
        tools[toolKey] = requirePolicyDecision(toolValue, `policy.tools["${toolKey}"]`);
      }

      config.policy.tools = tools;
    }
  }

  return config;
};
