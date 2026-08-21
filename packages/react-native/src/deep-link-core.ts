import type {
  CordieriteBootstrapConnectInput as BootstrapConnectInput,
  CordieriteConnectCallOptions,
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
  /** The held — or in-flight — session id, used to tell a re-delivered link from a new one. */
  getSessionId(): string | null;
  connect(
    input: CordieriteConnectInput,
    options?: CordieriteConnectCallOptions,
  ): Promise<void>;
  reportBootstrapError(event: {
    phase: "parse" | "connect";
    error: unknown;
  }): void;
};

/** True if `rawUrl` parses as a URL and includes a `cordierite` query parameter. */
export function hasCordieriteBootstrapQuery(
  rawUrl: string | null | undefined,
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
 * Ignores URLs without a `cordierite` query param.
 *
 * A delivered deep link outranks whatever session is currently held. Something with local access
 * to this device asked for *this* session just now, which is a fresher and far more deliberate
 * signal than a session the app happens to be sitting on — very often one restored from the native
 * process-memory lease after a Metro reload, pointing at a daemon that may no longer exist. So an
 * active or connecting session is superseded rather than allowed to veto the link. Ignoring it
 * instead (as this did before) is unrecoverable and completely invisible: the operator's
 * `wait_for_session` blocks until it times out while the app looks perfectly healthy.
 *
 * Two things bound that:
 *
 * 1. **A link for the session already held is ignored, not re-claimed.** The same link can be
 *    delivered twice (`getInitialURL` overlapping the `url` event on a cold start, or a human
 *    re-opening it), and its token is single-use — the daemon answers a second claim with a
 *    terminal `1008 already_claimed`, which now ends the session outright. Tearing down a healthy
 *    session to re-claim a consumed link would leave the app with nothing at all.
 * 2. **Nothing is torn down until the new payload validates.** Parsing happens before the session
 *    is even inspected, so a malformed, expired, or policy-rejected link cannot cost the app the
 *    session it already has.
 *
 * `client.getState()`/`getSessionId()` are called behind a try/catch: some
 * `CordieriteAutoBootstrapClient` implementations (the web stub in particular) may throw, and a
 * deep link can arrive before an app has had a chance to guard against calling Cordierite APIs on
 * an unsupported platform. A throw is reported like any other bootstrap failure rather than
 * crashing the caller.
 */
export function handleCordieriteDeepLinkUrl(
  client: CordieriteAutoBootstrapClient,
  rawUrl: string | null | undefined,
  options: HandleCordieriteDeepLinkOptions = {},
): void {
  if (!hasCordieriteBootstrapQuery(rawUrl ?? null)) {
    return;
  }

  const url = rawUrl ?? null;

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const requirePrivateIp = options.requirePrivateIp ?? true;

  // Parsed first, deliberately: everything below can end a live session, and only a payload that
  // has already proven itself valid, unexpired, and within the address policy earns that.
  let bootstrap: BootstrapConnectInput;
  try {
    bootstrap = parseBootstrapUrl(url!, { now, requirePrivateIp });
  } catch (error) {
    client.reportBootstrapError({ phase: "parse", error });
    return;
  }

  let state: CordieriteConnectionState;
  let heldSessionId: string | null;
  try {
    state = client.getState();
    heldSessionId = client.getSessionId();
  } catch (error) {
    logger.warn(
      "Cordierite: reading client state failed while handling a deep link",
      error,
    );
    client.reportBootstrapError({ phase: "parse", error });
    return;
  }

  const holdsSession = state === "connecting" || state === "active";

  if (holdsSession && heldSessionId === bootstrap.sessionId) {
    logger.debug(
      "Cordierite deep link ignored: already on this session",
      state,
    );
    return;
  }

  if (holdsSession) {
    logger.info(
      "Cordierite deep link superseding the current session; it was",
      state,
    );
  }

  client
    .connect(bootstrap, { supersede: holdsSession })
    .catch((error: unknown) => {
      client.reportBootstrapError({ phase: "connect", error });
    });
}
