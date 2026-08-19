import type {
  CordieriteConnectionState,
  CordieriteConnectInput,
} from "./Cordierite.types";
import { parseBootstrapUrl } from "./bootstrap";
import { logger } from "./logger";

/**
 * Structural seam the auto-bootstrap flow needs from a Cordierite client: startup recovery,
 * state + connect (both platforms), plus routing parse/connect failures onto the client's single
 * unified error channel (ARCHITECTURE.md §11) instead of a bespoke bootstrap-only listener set.
 */
export type CordieriteAutoBootstrapClient = {
  /** Starts recovery from the native process-memory lease, if one is available. */
  restoreSession(): Promise<boolean>;
  getState(): CordieriteConnectionState;
  connect(input: CordieriteConnectInput): Promise<void>;
  reportBootstrapError(event: {
    phase: "parse" | "connect";
    error: unknown;
  }): void;
};

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
  /**
   * Reject bootstrap payloads whose address is not a private/loopback range. Defaults to `true`
   * (fail-closed). Not an app-facing knob: `deep-link-install.ts` supplies it from the native
   * `allowPrivateLanOnly` build config, the same value native `connect()` enforces.
   */
  requirePrivateIp?: boolean;
};

/**
 * If the URL carries a Cordierite bootstrap payload, parse it and start `connect`.
 * Ignores URLs without a `cordierite` query param. Skips when already connecting or active.
 *
 * `client.getState()` is called behind a try/catch: some `CordieriteAutoBootstrapClient`
 * implementations (the web stub in particular) may throw from `getState()`, and a deep link can
 * arrive before an app has had a chance to guard against calling Cordierite APIs on an unsupported
 * platform. A throwing `getState()` is reported like any other bootstrap failure rather than
 * crashing the caller.
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

  let state: CordieriteConnectionState;
  try {
    state = client.getState();
  } catch (error) {
    logger.warn(
      "Cordierite: getState() failed while handling a deep link",
      error
    );
    client.reportBootstrapError({ phase: "parse", error });
    return;
  }

  if (state === "connecting" || state === "active") {
    logger.debug("Cordierite deep link ignored: session already", state);
    return;
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const requirePrivateIp = options.requirePrivateIp ?? true;

  let bootstrap: CordieriteConnectInput;
  try {
    bootstrap = parseBootstrapUrl(url!, { now, requirePrivateIp });
  } catch (error) {
    client.reportBootstrapError({ phase: "parse", error });
    return;
  }

  client.connect(bootstrap).catch((error: unknown) => {
    client.reportBootstrapError({ phase: "connect", error });
  });
}
