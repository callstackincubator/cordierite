import {
  isSessionAckMessage,
  isSessionBoundMessage,
  type EventMessage,
  type SessionAckMessage,
} from "@cordierite/shared";

import type {
  CordieriteCloseEvent,
  CordieriteConnectionState,
  CordieriteConnectCallOptions,
  CordieriteConnectInput,
  CordieriteConnectOptions,
  CordieriteClientState,
  CordieriteListenerKind,
  CordieriteModuleEvents,
  CordieriteOutboundMessage,
  CordieriteToolRegistration,
  CordieriteUnifiedErrorEvent,
  CordieriteUnifiedListenerMap,
} from "../Cordierite.types";
import { CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS } from "../Cordierite.types";
import type {
  CordieriteNativeModuleLike,
  CreateCordieriteClientOptions,
} from "../client-types";
import {
  isConnectOptionsValid,
  toConnectOptions,
  toResumeConnectOptions,
} from "../connect-helpers";
import { logger, maskSessionId } from "../logger";
import type { AppStateLike, AppStateStatus } from "./app-state";
import { computeFullJitterBackoffMs } from "./backoff";
import { createUnifiedListenerBus } from "./listeners";
import { createToolRegistry, type RegistryDelta } from "./registry";
import { isResumeLeaseExpired, parseResumeLease } from "./resume-lease";
import {
  CordieriteHandshakeClosedError,
  isTerminalCloseEvent,
  isTerminalHandshakeRejection,
  terminalCloseReason,
} from "./terminal-close";
import {
  systemClientTimers,
  type ClientTimerHandle,
  type ClientTimers,
} from "./timers";
import { createToolMessageHandler } from "./tool-invocation";

export type {
  CordieriteNativeModuleLike,
  CreateCordieriteClientOptions,
} from "../client-types";

type HeldSession = {
  sessionId: string;
  resumeToken: string;
  alias: string;
  keepaliveIntervalS: number;
  graceS: number;
  disconnectedAtMs: number | null;
  endpoint: { ip: string; port: number };
};

type PendingAttempt = {
  resolve: (ack: SessionAckMessage) => void;
  reject: (error: unknown) => void;
};

const noopAppState: AppStateLike = {
  currentState: "active",
  addEventListener: () => ({ remove() {} }),
};

/** Best-effort fire-and-forget: every promise gets a rejection handler (v1's `void promise` leak). */
const fireAndForget = (
  promise: Promise<unknown>,
  context: string,
  onError: (event: CordieriteUnifiedErrorEvent) => void
): void => {
  promise.catch((error: unknown) => {
    logger.warn(`Cordierite failed to ${context}`, error);
    onError({
      phase: "socket",
      message: `Failed to ${context}.`,
      cause: error,
    });
  });
};

export const createCordieriteClient = (
  module: CordieriteNativeModuleLike,
  clientOptions: CreateCordieriteClientOptions = {}
) => {
  const timers: ClientTimers = clientOptions.timers ?? systemClientTimers;
  const appState: AppStateLike = clientOptions.appState ?? noopAppState;
  const defaultToolTimeoutMs =
    clientOptions.defaultToolTimeoutMs ?? CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS;
  const resumeLeaseStore = clientOptions.resumeLeaseStore;

  const listenerBus = createUnifiedListenerBus();

  let clientState: CordieriteClientState = "idle";
  let heldSession: HeldSession | null = null;
  let epoch = 0;
  let pendingAttempt: PendingAttempt | null = null;
  let reconnectAttempt = 0;
  let reconnectTimerHandle: ClientTimerHandle | null = null;
  let graceTimerHandle: ClientTimerHandle | null = null;
  let resumeInFlight = false;
  let backgrounded = appState.currentState !== "active";
  let destroyed = false;

  const emitError = (event: CordieriteUnifiedErrorEvent) =>
    listenerBus.emit("error", event);

  const setClientState = (next: CordieriteClientState, reason?: string) => {
    if (clientState === next && reason === undefined) {
      return;
    }
    clientState = next;
    listenerBus.emit(
      "stateChange",
      reason ? { state: next, reason } : { state: next }
    );
  };

  const getSessionId = () => heldSession?.sessionId ?? null;

  /** The session an in-flight `connect()` is claiming, before any ack sets `heldSession`. Read
   * only by the public `getSessionId()`, never by `send`/tool routing — those must continue to
   * see `null` until a session is genuinely established. */
  let connectingSessionId: string | null = null;

  const rawSend = (json: string) => module.send(json);

  const clearReconnectTimer = () => {
    if (reconnectTimerHandle !== null) {
      timers.clearTimeout(reconnectTimerHandle);
      reconnectTimerHandle = null;
    }
  };

  const clearGraceTimer = () => {
    if (graceTimerHandle !== null) {
      timers.clearTimeout(graceTimerHandle);
      graceTimerHandle = null;
    }
  };

  const clearResumeLease = () => {
    try {
      resumeLeaseStore?.clear();
    } catch (error) {
      logger.warn("Cordierite failed to clear the resume lease", error);
    }
  };

  const sendSnapshot = async () => {
    if (clientState !== "active" || !heldSession) {
      return;
    }
    await rawSend(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: heldSession.sessionId,
        tools: registry.getDescriptors(),
      })
    );
  };

  const sendDelta = async (delta: RegistryDelta) => {
    if (clientState !== "active" || !heldSession) {
      return;
    }
    await rawSend(
      JSON.stringify({
        type: "tool_registry_delta",
        session_id: heldSession.sessionId,
        ...delta,
      })
    );
  };

  const registry = createToolRegistry({
    defaultTimeoutMs: defaultToolTimeoutMs,
    onDelta: (delta) =>
      fireAndForget(sendDelta(delta), "sync the tool registry", emitError),
  });

  const { handleMessage: invokeRegisteredTool, abortAllInFlight } = createToolMessageHandler({
    getSessionId,
    getRegistry: () => registry.entries,
    sendWire: rawSend,
    timers,
    onError: emitError,
  });

  // --- handshake (claim/resume) plumbing ---

  const settlePendingAttempt = (
    outcome:
      | { ok: true; ack: SessionAckMessage }
      | { ok: false; error: unknown }
  ): boolean => {
    const attempt = pendingAttempt;
    if (!attempt) {
      return false;
    }
    pendingAttempt = null;
    if (outcome.ok) {
      attempt.resolve(outcome.ack);
    } else {
      attempt.reject(outcome.error);
    }
    return true;
  };

  const performHandshake = (
    options: CordieriteConnectOptions
  ): Promise<SessionAckMessage> => {
    return new Promise<SessionAckMessage>((resolve, reject) => {
      pendingAttempt = { resolve, reject };
      module.connect(options).catch((error: unknown) => {
        settlePendingAttempt({ ok: false, error });
      });
    });
  };

  const onAckReceived = (
    ack: SessionAckMessage,
    kind: "claimed" | "resumed",
    endpoint: { ip: string; port: number }
  ) => {
    clearReconnectTimer();
    clearGraceTimer();
    reconnectAttempt = 0;
    resumeInFlight = false;

    heldSession = {
      sessionId: ack.session_id,
      resumeToken: ack.resume_token,
      alias: ack.alias,
      keepaliveIntervalS: ack.keepalive_interval_s,
      graceS: ack.grace_s,
      disconnectedAtMs: null,
      endpoint,
    };

    setClientState("active");
    listenerBus.emit("sessionChange", {
      type: kind,
      sessionId: heldSession.sessionId,
      alias: heldSession.alias,
    });

    fireAndForget(sendSnapshot(), "send the tool registry snapshot", emitError);
  };

  const finalizeSessionLost = (reason: string) => {
    const alias = heldSession?.alias ?? null;
    const sessionId = heldSession?.sessionId ?? null;

    epoch += 1;
    clearReconnectTimer();
    clearGraceTimer();
    heldSession = null;
    resumeInFlight = false;
    clearResumeLease();
    settlePendingAttempt({
      ok: false,
      error: new Error(`Cordierite session was lost: ${reason}.`),
    });

    setClientState("closed", reason);
    if (sessionId !== null) {
      listenerBus.emit("sessionChange", {
        type: "lost",
        sessionId,
        alias,
        reason,
      });
    }
  };

  const scheduleReconnectAttempt = (myEpoch: number) => {
    if (myEpoch !== epoch || destroyed || !heldSession) {
      return;
    }

    setClientState("reconnecting");

    if (backgrounded) {
      // Do not schedule a timer while backgrounded: the socket stays as the OS left it, and the
      // foreground handler below triggers an immediate attempt on return.
      return;
    }

    const delay = computeFullJitterBackoffMs(reconnectAttempt, {
      random: timers.random,
    });
    reconnectAttempt += 1;

    reconnectTimerHandle = timers.setTimeout(() => {
      reconnectTimerHandle = null;
      void attemptResume(myEpoch);
    }, delay);
  };

  const scheduleGraceExpiry = (myEpoch: number) => {
    if (graceTimerHandle !== null || !heldSession) {
      return;
    }

    const now = timers.now();
    const disconnectedAtMs = heldSession.disconnectedAtMs ?? now;
    heldSession.disconnectedAtMs = disconnectedAtMs;
    const remainingGraceMs =
      heldSession.graceS * 1000 - (now - disconnectedAtMs);

    graceTimerHandle = timers.setTimeout(() => {
      graceTimerHandle = null;
      if (myEpoch === epoch && heldSession) {
        finalizeSessionLost("grace_expired");
      }
    }, Math.max(remainingGraceMs, 0));
  };

  const attemptResume = async (myEpoch: number): Promise<void> => {
    if (resumeInFlight || destroyed || myEpoch !== epoch || !heldSession) {
      return;
    }

    const now = timers.now();
    const disconnectedAtMs = heldSession.disconnectedAtMs ?? now;
    heldSession.disconnectedAtMs = disconnectedAtMs;
    if (now - disconnectedAtMs >= heldSession.graceS * 1000) {
      finalizeSessionLost("grace_expired");
      return;
    }

    resumeInFlight = true;
    const session = heldSession;
    const options = toResumeConnectOptions({
      ip: session.endpoint.ip,
      port: session.endpoint.port,
      sessionId: session.sessionId,
      resumeToken: session.resumeToken,
      now: Math.floor(now / 1000),
      graceSeconds: session.graceS,
    });

    let ack: SessionAckMessage;
    try {
      ack = await performHandshake(options);
    } catch (error) {
      resumeInFlight = false;
      if (myEpoch !== epoch || destroyed) {
        return;
      }
      emitError({
        phase: "socket",
        message: "Cordierite resume attempt failed.",
        cause: error,
      });
      if (isTerminalHandshakeRejection(error)) {
        // The daemon rejected the resume itself (`unknown_session` after a daemon restart, an
        // expired/revoked session, `invalid_resume_token`). Retrying the identical frame until the
        // grace window runs out would leave the app in `reconnecting` for up to `grace_s` — minutes
        // — before it ever hears `sessionChange: lost`. Finalize now instead.
        finalizeSessionLost(terminalCloseReason(error.closeEvent));
        return;
      }
      scheduleReconnectAttempt(myEpoch);
      return;
    }

    resumeInFlight = false;
    if (myEpoch !== epoch || destroyed) {
      return;
    }
    onAckReceived(ack, "resumed", session.endpoint);
  };

  const onSocketLost = (
    event: CordieriteCloseEvent,
    lastError: CordieriteModuleEvents["error"] extends (e: infer E) => void
      ? E | null
      : never
  ) => {
    if (destroyed) {
      return;
    }

    // The socket is gone, so no `tool_cancel` frame could ever be delivered for whatever was
    // still in flight — abort it directly rather than leaving handlers running with no owner.
    abortAllInFlight();

    const myEpoch = epoch;

    if (!heldSession) {
      setClientState("closed", "socket_closed");
      return;
    }

    if (event.code === 1000) {
      finalizeSessionLost("revoked");
      return;
    }

    emitError({
      phase: "socket",
      message:
        event.reason ?? lastError?.message ?? "Cordierite connection lost.",
      code: lastError?.code,
      nativeCode: lastError?.nativeCode,
      closeReason: event.reason,
      isRetryable: lastError?.isRetryable,
      hint: lastError?.hint,
    });

    if (isTerminalCloseEvent(event)) {
      // A policy-violation close mid-session (e.g. the daemon rejected a frame we sent) is as
      // unresumable as one during the handshake — see `attemptResume`'s matching branch.
      finalizeSessionLost(terminalCloseReason(event));
      return;
    }

    const now = timers.now();
    const disconnectedAtMs = heldSession.disconnectedAtMs ?? now;
    heldSession.disconnectedAtMs = disconnectedAtMs;
    if (now - disconnectedAtMs >= heldSession.graceS * 1000) {
      finalizeSessionLost("grace_expired");
      return;
    }

    scheduleGraceExpiry(myEpoch);
    scheduleReconnectAttempt(myEpoch);
  };

  // --- native module wiring (registered once; removed on `destroy()`) ---

  let lastErrorEvent: CordieriteModuleEvents["error"] extends (
    e: infer E
  ) => void
    ? E | null
    : never = null;

  const messageSubscription = module.addListener("message", (event) => {
    if (isSessionAckMessage(event.message)) {
      if (!settlePendingAttempt({ ok: true, ack: event.message })) {
        logger.debug("stray session_ack ignored (no handshake in flight)");
      }
      return;
    }

    fireAndForget(
      invokeRegisteredTool(event.message),
      "dispatch an incoming tool call",
      emitError
    );
  });

  const errorSubscription = module.addListener("error", (event) => {
    lastErrorEvent = event;
    logger.warn("connection error", event);
  });

  const closeSubscription = module.addListener("close", (event) => {
    const errorEvent = lastErrorEvent;
    lastErrorEvent = null;

    // A close that lands while a claim/resume is in flight settles *that attempt* and stops here —
    // `onSocketLost` never sees it. So the close event travels with the rejection, letting
    // `attemptResume` tell a terminal daemon rejection apart from a retryable transport failure.
    if (
      settlePendingAttempt({
        ok: false,
        error: new CordieriteHandshakeClosedError(
          event.reason ??
            errorEvent?.message ??
            "Cordierite connection closed.",
          event
        ),
      })
    ) {
      return;
    }

    onSocketLost(event, errorEvent);
  });

  const appStateSubscription = appState.addEventListener(
    "change",
    (next: AppStateStatus) => {
      const nowBackground = next !== "active";
      if (nowBackground === backgrounded) {
        return;
      }
      backgrounded = nowBackground;

      if (backgrounded) {
        clearReconnectTimer();
        return;
      }

      if (heldSession && clientState === "reconnecting" && !resumeInFlight) {
        clearReconnectTimer();
        void attemptResume(epoch);
      }
    }
  );

  return {
    /**
     * Starts recovery from a native-owned process-memory lease when this client is idle. Resolves
     * `true` once the resume attempt has been accepted and started; it does not wait for the
     * daemon's `session_ack`. Resolves `false` when no valid, unexpired lease can be restored.
     */
    async restoreSession(): Promise<boolean> {
      if (
        !resumeLeaseStore ||
        destroyed ||
        heldSession !== null ||
        (clientState !== "idle" && clientState !== "closed")
      ) {
        return false;
      }

      let storedValue: unknown;
      try {
        storedValue = resumeLeaseStore.get();
      } catch (error) {
        logger.warn("Cordierite failed to read the resume lease", error);
        return false;
      }

      if (storedValue === null || storedValue === undefined) {
        return false;
      }

      const lease = parseResumeLease(storedValue);
      const now = timers.now();
      if (!lease || isResumeLeaseExpired(lease, now)) {
        clearResumeLease();
        return false;
      }

      const nativeState = module.getState();
      if (nativeState === "connecting" || nativeState === "active") {
        return false;
      }

      epoch += 1;
      const myEpoch = epoch;
      clearReconnectTimer();
      clearGraceTimer();
      reconnectAttempt = 0;
      heldSession = {
        sessionId: lease.sessionId,
        resumeToken: lease.resumeToken,
        alias: lease.alias,
        keepaliveIntervalS: lease.keepaliveIntervalS,
        graceS: lease.graceS,
        disconnectedAtMs: lease.disconnectedAtMs ?? now,
        endpoint: lease.endpoint,
      };
      setClientState("reconnecting");
      scheduleGraceExpiry(myEpoch);
      fireAndForget(attemptResume(myEpoch), "restore the session", emitError);
      return true;
    },

    /**
     * Runs the v2 claim handshake: validates the bootstrap, hands the exact `session_claim`
     * first-frame to native, and resolves once `session_ack` is received (not merely once native
     * has accepted the socket). On success the resume token, alias, and grace/keepalive intervals
     * are held in memory and a full tool registry snapshot is sent.
     */
    async connect(
      input: CordieriteConnectInput,
      connectOptions?: CordieriteConnectCallOptions,
    ): Promise<void> {
      const options = toConnectOptions(input, clientOptions);
      const nowSeconds = Math.floor(timers.now() / 1000);

      // Validated before anything is torn down: `supersede` closes a live session, so an invalid
      // or expired payload must not be able to cost the caller the session it already has.
      if (!isConnectOptionsValid(options, nowSeconds)) {
        logger.debug("connect rejected: invalid or expired bootstrap payload");
        throw new Error("Invalid or expired Cordierite bootstrap payload.");
      }

      const nativeState = module.getState();
      // `reconnecting` supersedes implicitly (the resume/backoff loop is this client's own work to
      // abandon). An explicit `supersede` is the bootstrap-link case: something with local access
      // to this device just delivered a *newer* session, which outranks whatever is held —
      // including a resume attempt wedged against a daemon that is no longer there.
      const supersedingReconnect =
        clientState === "reconnecting" || connectOptions?.supersede === true;
      if (
        (nativeState === "connecting" || nativeState === "active") &&
        !supersedingReconnect
      ) {
        logger.debug("connect rejected: already", nativeState);
        throw new Error(
          "A Cordierite session is already connecting or active."
        );
      }

      logger.debug("connect", {
        host: `${options.ip}:${options.port}`,
        session: maskSessionId(options.sessionId),
      });

      epoch += 1;
      const myEpoch = epoch;
      clearReconnectTimer();
      clearGraceTimer();
      reconnectAttempt = 0;
      heldSession = null;
      connectingSessionId = options.sessionId;
      resumeInFlight = false;
      clearResumeLease();
      if (supersedingReconnect) {
        settlePendingAttempt({
          ok: false,
          error: new Error(
            "Cordierite recovery was superseded by a fresh connection."
          ),
        });
      }

      let ack: SessionAckMessage;
      try {
        if (
          supersedingReconnect &&
          (nativeState === "connecting" || nativeState === "active")
        ) {
          await module.close();
        }
        setClientState("connecting");
        ack = await performHandshake(options);
      } catch (error) {
        if (myEpoch === epoch) {
          connectingSessionId = null;
          setClientState("closed", "connect_error");
          emitError({
            phase: "connect",
            message:
              error instanceof Error
                ? error.message
                : "Cordierite connect failed.",
            cause: error,
          });
        }
        throw error;
      }

      if (myEpoch !== epoch) {
        // Superseded by a newer `connect()` call while awaiting the ack; abandon silently. The
        // newer attempt owns `connectingSessionId` now, so leave it alone.
        return;
      }

      connectingSessionId = null;
      onAckReceived(ack, "claimed", { ip: options.ip, port: options.port });
    },

    async send(message: CordieriteOutboundMessage): Promise<void> {
      const currentSessionId = getSessionId();

      if (clientState !== "active" || !currentSessionId) {
        logger.debug("send rejected: session not active");
        throw new Error("Cordierite session is not active.");
      }

      if (typeof message === "string") {
        const parsed = JSON.parse(message) as unknown;
        const sessionBoundMessage = isSessionBoundMessage(parsed)
          ? parsed
          : null;

        if (
          sessionBoundMessage &&
          sessionBoundMessage.session_id !== currentSessionId
        ) {
          logger.debug("send rejected: session_id mismatch");
          throw new Error(
            "Outgoing Cordierite message session_id does not match the active session."
          );
        }

        logger.debug("send (raw string)");
        await rawSend(message);
        return;
      }

      const payload = { ...message };

      if ("session_id" in payload && payload.session_id !== undefined) {
        if (payload.session_id !== currentSessionId) {
          logger.debug("send rejected: session_id mismatch");
          throw new Error(
            "Outgoing Cordierite message session_id does not match the active session."
          );
        }
      } else {
        payload.session_id = currentSessionId;
      }

      logger.debug("send", payload.type);
      await rawSend(JSON.stringify(payload));
    },

    /** Emits an `event` frame while active; drops (with a dev warning) otherwise. Never throws. */
    async postEvent(name: string, payload?: unknown): Promise<void> {
      const sessionId = getSessionId();

      if (clientState !== "active" || !sessionId) {
        logger.devWarn(
          `postEvent("${name}") dropped: no active Cordierite session.`
        );
        return;
      }

      const message: EventMessage = {
        type: "event",
        session_id: sessionId,
        name,
        ...(payload !== undefined ? { payload } : {}),
        ts: timers.now(),
      };

      try {
        await rawSend(JSON.stringify(message));
      } catch (error) {
        logger.warn(`postEvent("${name}") failed to send`, error);
        emitError({
          phase: "socket",
          message: `Failed to send event "${name}".`,
          cause: error,
        });
      }
    },

    async close(): Promise<void> {
      logger.debug("close");
      epoch += 1;
      clearReconnectTimer();
      clearGraceTimer();

      const hadSession = heldSession !== null;
      const alias = heldSession?.alias ?? null;
      const sessionId = heldSession?.sessionId ?? null;
      heldSession = null;
      resumeInFlight = false;
      clearResumeLease();

      // A `connect()`/resume attempt in flight must not hang forever: nothing else will ever
      // settle it once the epoch bump below makes onAckReceived/attemptResume treat it as stale.
      settlePendingAttempt({
        ok: false,
        error: new Error("Cordierite client was closed."),
      });

      setClientState("closed", "closed_by_app");
      if (hadSession) {
        listenerBus.emit("sessionChange", {
          type: "lost",
          sessionId,
          alias,
          reason: "closed_by_app",
        });
      }

      await module.close();
    },

    /** Raw native connection state (no resume concept — see `getClientState()` for the unified surface). */
    getState(): CordieriteConnectionState {
      return module.getState();
    },

    /** The session currently held, or the one an in-flight `connect()` is claiming, or `null`.
     * Lets a caller distinguish a re-delivery of the link it is already on (ignore) from a
     * genuinely new one (supersede) — see `deep-link-core`. Covers the connecting window on
     * purpose: a link delivered twice during its own handshake must not supersede itself. */
    getSessionId(): string | null {
      return getSessionId() ?? connectingSessionId;
    },

    /** Unified client state: `idle | connecting | active | reconnecting | closed`. */
    getClientState(): CordieriteClientState {
      return clientState;
    },

    /** Raw native event passthrough, for advanced/testing use. Prefer `addCordieriteListener`. */
    addListener<Event extends keyof CordieriteModuleEvents>(
      eventName: Event,
      listener: CordieriteModuleEvents[Event]
    ) {
      return module.addListener(eventName, listener);
    },

    /** Unified listener API (ARCHITECTURE.md §11): `stateChange`, `sessionChange`, `error`. */
    addCordieriteListener<Kind extends CordieriteListenerKind>(
      kind: Kind,
      callback: CordieriteUnifiedListenerMap[Kind]
    ) {
      return listenerBus.addListener(kind, callback);
    },

    /** @internal used by `deep-link-core` to route parse/connect failures onto the unified error channel. */
    reportBootstrapError(event: {
      phase: "parse" | "connect";
      error: unknown;
    }): void {
      emitError({
        phase: "bootstrap",
        message:
          event.error instanceof Error
            ? event.error.message
            : "Cordierite bootstrap error.",
        cause: event.error,
      });
    },

    registerTool<
      TInputSchema extends
        | import("@cordierite/shared").StandardSchemaV1
        | undefined,
      TOutputSchema extends
        | import("@cordierite/shared").StandardSchemaV1
        | undefined
    >(registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>) {
      return registry.registerTool(registration);
    },

    unregisterTool(name: string): void {
      registry.unregisterTool(name);
    },

    getRegisteredTools() {
      return registry.getDescriptors();
    },

    /** Removes every listener this client attached to `module`. Call when discarding a client instance. */
    destroy(): void {
      destroyed = true;
      clearReconnectTimer();
      clearGraceTimer();
      // A `connect()`/resume attempt in flight must not hang forever: once listeners are removed
      // below, nothing will ever settle it (no `session_ack` or `close` can reach it).
      settlePendingAttempt({
        ok: false,
        error: new Error("Cordierite client was destroyed."),
      });
      // Same reasoning as above, for tool handlers: once listeners are removed below, no
      // `tool_cancel` frame or transport-loss signal will ever reach an in-flight handler again.
      abortAllInFlight();
      messageSubscription.remove();
      errorSubscription.remove();
      closeSubscription.remove();
      appStateSubscription.remove();
    },
  };
};

export type CordieriteClient = ReturnType<typeof createCordieriteClient>;
