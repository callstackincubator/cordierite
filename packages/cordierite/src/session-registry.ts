import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolDescriptor } from "cordierite-shared";

import { connectionError } from "./errors.js";

export type CordieriteSessionRegistryEntry = {
  sessionId: string;
  controlPort: number;
  wssPort: number;
  ip: string;
  pid: number;
  registeredAt: string;
  lastSeenAt: string;
  status: "pending" | "active";
  endpoint: {
    ip: string;
    port: number;
    url: string;
  };
  remoteTools: ToolDescriptor[];
};

/** Opaque session ids (base64url alphabet, no path metacharacters). */
const OPAQUE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

export const isValidOpaqueSessionId = (sessionId: string): boolean =>
  OPAQUE_SESSION_ID_PATTERN.test(sessionId);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const getCordieriteSessionsDir = (): string => {
  const fromEnv = process.env.CORDIERITE_SESSIONS_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return join(tmpdir(), "cordierite-sessions");
};

const sessionFilePath = (sessionsDir: string, sessionId: string): string => {
  if (!isValidOpaqueSessionId(sessionId)) {
    throw connectionError("Invalid session id.", { session_id: sessionId });
  }
  return join(sessionsDir, `${sessionId}.json`);
};

export const writeSessionRegistryEntry = async (entry: CordieriteSessionRegistryEntry): Promise<void> => {
  if (!isValidOpaqueSessionId(entry.sessionId)) {
    throw connectionError("Invalid session id in registry entry.", { session_id: entry.sessionId });
  }
  const dir = getCordieriteSessionsDir();
  await mkdir(dir, { recursive: true });
  const finalPath = sessionFilePath(dir, entry.sessionId);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(entry)}\n`, "utf8");
  await rename(tmpPath, finalPath);
};

export const deleteSessionRegistryEntry = async (sessionId: string): Promise<void> => {
  if (!isValidOpaqueSessionId(sessionId)) {
    return;
  }
  const dir = getCordieriteSessionsDir();
  const finalPath = sessionFilePath(dir, sessionId);
  try {
    await unlink(finalPath);
  } catch {
    // Ignore missing files.
  }
};

const parseEntry = (raw: string): CordieriteSessionRegistryEntry | null => {
  try {
    const parsed = JSON.parse(raw) as CordieriteSessionRegistryEntry;
    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.controlPort !== "number" ||
      typeof parsed.wssPort !== "number" ||
      typeof parsed.ip !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.registeredAt !== "string" ||
      typeof parsed.lastSeenAt !== "string" ||
      (parsed.status !== "pending" && parsed.status !== "active") ||
      typeof parsed.endpoint !== "object" ||
      parsed.endpoint === null ||
      typeof parsed.endpoint.ip !== "string" ||
      typeof parsed.endpoint.port !== "number" ||
      typeof parsed.endpoint.url !== "string" ||
      !Array.isArray(parsed.remoteTools)
    ) {
      return null;
    }
    if (!isValidOpaqueSessionId(parsed.sessionId)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const readSessionRegistryEntry = async (
  sessionId: string,
  options: { pruneDead?: boolean } = {},
): Promise<CordieriteSessionRegistryEntry | null> => {
  if (!isValidOpaqueSessionId(sessionId)) {
    return null;
  }

  const dir = getCordieriteSessionsDir();
  const path = join(dir, `${sessionId}.json`);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }

  const entry = parseEntry(raw);
  if (!entry) {
    return null;
  }

  if (entry.sessionId !== sessionId) {
    return null;
  }

  if (options.pruneDead !== false && !isProcessAlive(entry.pid)) {
    await unlink(path).catch(() => {});
    return null;
  }

  return entry;
};

export const listAndPruneSessionRegistryEntries = async (): Promise<CordieriteSessionRegistryEntry[]> => {
  const dir = getCordieriteSessionsDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const entries: CordieriteSessionRegistryEntry[] = [];

  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }

    const stem = name.slice(0, -".json".length);
    if (!isValidOpaqueSessionId(stem)) {
      continue;
    }

    const path = join(dir, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }

    const entry = parseEntry(raw);
    if (!entry || entry.sessionId !== stem) {
      continue;
    }

    if (!isProcessAlive(entry.pid)) {
      await unlink(path).catch(() => {});
      continue;
    }

    entries.push(entry);
  }

  entries.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return entries;
};

export const resolveSessionRegistryEntry = async (sessionId: string): Promise<CordieriteSessionRegistryEntry> => {
  const entry = await readSessionRegistryEntry(sessionId, { pruneDead: true });
  if (!entry) {
    throw connectionError(`No Cordierite host session found for session id "${sessionId}".`, {
      session_id: sessionId,
      sessions_dir: getCordieriteSessionsDir(),
    });
  }
  return entry;
};
