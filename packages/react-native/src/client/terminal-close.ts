import type { CordieriteCloseEvent } from "../Cordierite.types";

/**
 * RFC 6455 "policy violation". Every daemon-side rejection that a `session_resume` (or
 * `session_claim`) can never talk its way out of closes with this code: `unknown_session`,
 * `invalid_resume_token`, `link_expired`, `already_claimed`, `claim_attempts_exceeded`,
 * `invalid_token`, `invalid_message`, `invalid_registry`, `unknown_message_type` (see the daemon's
 * `closeSocket` call sites in `packages/cordierite/src/daemon/sessions.ts`). Retrying an identical
 * frame against any of them can only fail the same way, so 1008 is treated as terminal wholesale
 * rather than by matching individual reason strings — a new daemon-side rejection reason is then
 * terminal by default instead of silently falling into the retry loop.
 *
 * Deliberately *not* terminal: 1011 (`send_failed`) and 1001 (`daemon_shutdown`) are transport-level
 * and genuinely worth retrying inside the grace window, as is 1006 (abnormal close — backgrounding,
 * network blips).
 */
export const POLICY_VIOLATION_CLOSE_CODE = 1008;

/** Whether the daemon closed with a rejection that no retry of the same frame could ever satisfy. */
export const isTerminalCloseEvent = (event: CordieriteCloseEvent): boolean =>
  event.code === POLICY_VIOLATION_CLOSE_CODE;

/** The `sessionChange: lost` reason to report for a terminal close — the daemon's own wire reason
 * (`unknown_session`, `invalid_resume_token`, …) when it sent one. */
export const terminalCloseReason = (event: CordieriteCloseEvent): string =>
  event.reason ?? "rejected_by_daemon";

/**
 * Rejection of an in-flight claim/resume handshake caused by the socket closing, carrying the close
 * event itself. Without this the close code is lost by the time `attemptResume` catches the
 * rejection — and that catch, not `onSocketLost`, is where a failed *resume* lands (the `close`
 * listener settles the pending attempt and returns early), so it is the retry loop that has to be
 * able to recognize a terminal rejection.
 */
export class CordieriteHandshakeClosedError extends Error {
  readonly closeEvent: CordieriteCloseEvent;

  constructor(message: string, closeEvent: CordieriteCloseEvent) {
    super(message);
    this.name = "CordieriteHandshakeClosedError";
    this.closeEvent = closeEvent;
  }
}

/** Whether `error` is a handshake rejection the daemon marked terminal. */
export const isTerminalHandshakeRejection = (
  error: unknown,
): error is CordieriteHandshakeClosedError =>
  error instanceof CordieriteHandshakeClosedError &&
  isTerminalCloseEvent(error.closeEvent);
