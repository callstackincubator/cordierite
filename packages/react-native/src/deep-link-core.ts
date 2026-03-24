import type {
  CordieriteConnectionState,
  CordieriteConnectInput,
} from "./Cordierite.types";
import { parseBootstrapUrl } from "./bootstrap";
import { logger } from "./logger";

/** Emitted when auto-bootstrap fails to parse the URL or `connect` rejects. */
export type CordieriteBootstrapErrorEvent = {
  phase: "parse" | "connect";
  url: string | null;
  error: unknown;
};

export type CordieriteAutoBootstrapClient = {
  getState(): CordieriteConnectionState;
  connect(input: CordieriteConnectInput): Promise<void>;
};

const errorListeners = new Set<
  (event: CordieriteBootstrapErrorEvent) => void
>();

/**
 * Subscribe to failures from the import-time deep-link bootstrap flow.
 * Does not replace `cordieriteClient.addListener("error", …)` for socket errors after connect.
 */
export function addCordieriteErrorListener(
  listener: (event: CordieriteBootstrapErrorEvent) => void
): { remove(): void } {
  errorListeners.add(listener);
  return {
    remove() {
      errorListeners.delete(listener);
    },
  };
}

function emitBootstrapError(event: CordieriteBootstrapErrorEvent): void {
  for (const listener of errorListeners) {
    try {
      listener(event);
    } catch (listenerError) {
      logger.warn("Cordierite bootstrap error listener threw", listenerError);
    }
  }
}

/** True if `rawUrl` parses as a URL and includes a `cordierite` query parameter. */
export function hasCordieriteBootstrapQuery(
  rawUrl: string | null | undefined
): boolean {
  if (!rawUrl) {
    return false;
  }
  try {
    return new URL(rawUrl).searchParams.has("cordierite");
  } catch {
    return false;
  }
}

export type HandleCordieriteDeepLinkOptions = {
  now?: number;
  requirePrivateIp?: boolean;
};

/**
 * If the URL carries a Cordierite bootstrap payload, parse it and start `connect`.
 * Ignores URLs without a `cordierite` query param. Skips when already connecting or active.
 */
export function handleCordieriteDeepLinkUrl(
  client: CordieriteAutoBootstrapClient,
  rawUrl: string | null | undefined,
  options: HandleCordieriteDeepLinkOptions = {}
): void {
  if (!hasCordieriteBootstrapQuery(rawUrl ?? null)) {
    return;
  }

  const url = rawUrl ?? null;
  const state = client.getState();
  if (state === "connecting" || state === "active") {
    logger.debug("Cordierite deep link ignored: session already", state);
    return;
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const requirePrivateIp = options.requirePrivateIp ?? true;

  try {
    const bootstrap = parseBootstrapUrl(url!, {
      now,
      requirePrivateIp,
    });
    void client.connect(bootstrap).catch((error: unknown) => {
      emitBootstrapError({ phase: "connect", url, error });
    });
  } catch (error) {
    emitBootstrapError({ phase: "parse", url, error });
  }
}

/** @internal Clears bootstrap error listeners between tests. */
export function __cordieriteResetDeepLinkBootstrapForTests(): void {
  errorListeners.clear();
}
