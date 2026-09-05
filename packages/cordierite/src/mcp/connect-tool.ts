/**
 * The built-in `cordierite_connect` / `cordierite_wait_for_session` management tools
 * (ARCHITECTURE.md §9 scope item 4): let an MCP agent bootstrap a device session without shell
 * access — mint a link (and, whenever a device can be found, deliver it via the task-07
 * emulator/simulator fast path), then wait for it to be claimed.
 *
 * Delivery is attempted by *default*, not only on request: an agent that omitted `target` used to
 * get a QR code, which is a flow that cannot complete without a human noticing and scanning it.
 * The overwhelmingly common case — one booted simulator or emulator, no human watching — now just
 * works, and the QR path is reserved for when there is genuinely nothing to deliver to (or the
 * caller asked for it with `target: "none"`), where it carries explicit instructions telling the
 * agent to show the code and ask.
 */

import {
  RPC_METHODS,
  type EventNotification,
  type LinkCreateResult,
  type SessionsDescribeResult,
} from "@cordierite/shared";

import {
  deliverToOpenTarget,
  detectBootedTargets,
  isOpenTarget,
  isValidBundleId,
  invalidBundleIdMessage,
  isLoopbackAddress,
  loopbackAddressMessage,
  usesLoopbackAddress,
  MISSING_BUNDLE_ID_MESSAGE,
  type ExecFn,
  type OpenTarget,
} from "../cli/open-target.js";
import { composeDeepLink } from "../link.js";
import { renderQrToTerminal } from "../qr-terminal.js";
import {
  openDaemonStream,
  DaemonRpcError,
  isDaemonUnreachableError,
  type DaemonStream,
  type SpawnFn,
} from "../rpc/client.js";
import type { DaemonCall } from "./daemon-tools.js";

export const CONNECT_TOOL_NAME = "cordierite_connect";
export const WAIT_FOR_SESSION_TOOL_NAME = "cordierite_wait_for_session";

/** The emulator/simulator fast path forces `127.0.0.1` — same reasoning as `cli/link.ts`. The
 * experimental `ios-device` target is excluded (`usesLoopbackAddress`): a physical iPhone reaches
 * the daemon only over the LAN. */
const OPEN_TARGET_ADDRESS_OVERRIDE = "127.0.0.1";

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

/** `target: "none"` — an explicit opt out of delivery, for when the human/QR flow is what is
 * actually wanted (a physical device on the same network, say). Distinct from omitting `target`,
 * which now means "figure it out". */
const NO_TARGET = "none";

type ConnectTarget = OpenTarget | typeof NO_TARGET;

/**
 * Attached to every QR-path result. Without this an agent reliably minted a link, said nothing
 * about it, and went straight to `cordierite_wait_for_session` — which then blocked for its full
 * timeout waiting on a scan nobody had been asked to perform.
 */
const QR_INSTRUCTIONS =
  "This link was NOT delivered to a device — a human has to open it. Before calling " +
  "cordierite_wait_for_session: show the user the \"qr\" field verbatim inside a fenced code block " +
  "(it is pre-rendered terminal art — do not redraw, summarize, or describe it), show \"deepLink\" " +
  "underneath it for a device that cannot scan, and ask the user to scan it with the target " +
  "device. Only then call cordierite_wait_for_session; it blocks until the device connects and " +
  "gives no output while it waits, so calling it before you have asked will look like a hang.";

export const CONNECT_TOOL_DESCRIPTOR = {
  name: CONNECT_TOOL_NAME,
  description:
    "Mint a Cordierite session link and get it onto a device. With no \"target\", auto-detects a " +
    "booted iOS simulator or attached Android device and delivers the link to it, returning " +
    "{ sessionId, delivered: true, autoDetected: true } — this is the normal agent path and needs " +
    "no human. Pass target \"android\" or \"ios-sim\" (optionally with \"device\") to choose " +
    "explicitly, or target \"none\" to force the human flow. Target \"ios-device\" is an " +
    "experimental, never-auto-detected path that delivers to a paired physical iPhone/iPad via " +
    "xcrun devicectl; it needs \"bundleId\" (or \"iosBundleId\" in config.json), iOS 17+, Xcode " +
    "15+, a connected and trusted device with Developer Mode on, a dev-signed build installed, and " +
    "the phone on the same network as this machine. Pass \"relaunch\": true with it if the app is " +
    "already running and the delivery does not take. Only when no device is " +
    "detected (or target is \"none\") does this return a QR code for a human to scan, along with " +
    "an \"instructions\" field saying what to do with it. Follow up with " +
    "cordierite_wait_for_session to know when the device has connected.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["android", "ios-sim", "ios-device", NO_TARGET] },
      device: { type: "string" },
      bundleId: { type: "string" },
      relaunch: { type: "boolean" },
      ttlSeconds: { type: "number", exclusiveMinimum: 0 },
    },
    additionalProperties: false,
  },
} as const;

export const WAIT_FOR_SESSION_TOOL_DESCRIPTOR = {
  name: WAIT_FOR_SESSION_TOOL_NAME,
  description:
    "Wait for a session minted by cordierite_connect to be claimed by a device. Resolves as soon " +
    "as the device connects (or immediately if it already has); rejects with tool_timeout if " +
    "timeoutMs elapses first. If cordierite_connect returned a QR instead of delivering the link, " +
    "show that QR to the user and ask them to scan it before calling this — it produces no output " +
    "while it waits.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      timeoutMs: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
} as const;

/** Errors from the built-in management tools reuse the daemon's wire `ErrorType` union
 * (`RpcApplicationError`-style: `{ type, message }`) so the MCP server's generic error-content
 * mapping (see `server.ts`) handles them the same way it handles a proxied device tool's error. */
export class McpBuiltinToolError extends Error {
  constructor(
    readonly type: "invalid_request" | "tool_timeout" | "tool_execution_error",
    message: string,
  ) {
    super(message);
    this.name = "McpBuiltinToolError";
  }
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

const asOptionalConnectTarget = (value: unknown): ConnectTarget | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !(isOpenTarget(value) || value === NO_TARGET)) {
    throw new McpBuiltinToolError(
      "invalid_request",
      '"target" must be "android", "ios-sim", "ios-device", or "none".',
    );
  }

  return value;
};

const asOptionalNonEmptyString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a non-empty string.`);
  }

  return value;
};

const asOptionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a boolean.`);
  }

  return value;
};

const asOptionalPositiveNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a positive number.`);
  }

  return value;
};

export type ConnectToolDeps = {
  call: DaemonCall;
  /** The scheme composing the deep link (`<scheme>:///?cordierite=<payload>`); same source order as
   * `cli/link.ts`: `--scheme` flag equivalent has no MCP analogue, so this is always config/derived. */
  scheme?: string;
  /** `config.json`'s `iosBundleId`, the default for the experimental `ios-device` target when the
   * call did not pass `bundleId`. Same source order as `scheme`. */
  iosBundleId?: string;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
};

export type ConnectToolResult = {
  sessionId: string;
  deepLink: string;
  expiresAt: number;
  delivered?: true;
  target?: OpenTarget;
  /** The adb serial / simulator udid the link was delivered to, when one was resolved. */
  device?: string;
  /** Set when no `target` was given and exactly one device was found and used. */
  autoDetected?: true;
  /** Why this call did or did not deliver — the deciding detail an agent needs to explain itself
   * (or to re-call with an explicit target). */
  note?: string;
  /** Present only on the QR path: a scannable QR of the deep link, rendered as text. */
  qr?: string;
  /** Present only on the QR path: what the agent must do before waiting. See {@link QR_INSTRUCTIONS}. */
  instructions?: string;
};

type ResolvedDelivery = {
  target: OpenTarget;
  device?: string;
  /** Resolved bundle id for `target: "ios-device"` (call argument, else `config.json`). */
  bundleId?: string;
  /** Human-readable device description for notes and errors. */
  label: string;
  autoDetected: boolean;
};

/**
 * Decides where (if anywhere) this link is going, *before* it is minted: the `127.0.0.1` address
 * override baked into a link depends on whether it is being delivered locally, and that cannot be
 * revised after `link.create`. A link minted for loopback and then fallen back to a QR code would
 * be unscannable-in-effect — the address would be wrong for the phone that scanned it.
 */
const resolveDelivery = async (
  requested: ConnectTarget | undefined,
  device: string | undefined,
  bundleId: string | undefined,
  deps: ConnectToolDeps,
): Promise<{ delivery?: ResolvedDelivery; note?: string }> => {
  if (requested !== undefined && requested !== NO_TARGET) {
    // `ios-device` is reachable only through this branch: `detectBootedTargets` never returns it,
    // so a paired iPhone can never be picked up by the auto-detection path below.
    return {
      delivery: {
        target: requested,
        device,
        ...(requested === "ios-device" ? { bundleId: bundleId ?? deps.iosBundleId } : {}),
        label: device ?? requested,
        autoDetected: false,
      },
    };
  }

  if (requested === NO_TARGET) {
    return {
      note: 'Called with target: "none", so no device delivery was attempted.',
    };
  }

  const detection = await detectBootedTargets({ exec: deps.exec, env: deps.env });

  if (detection.kind === "single") {
    return { delivery: { ...detection.detected, autoDetected: true } };
  }

  if (detection.kind === "ambiguous") {
    return {
      note:
        'No "target" was given and several devices are available (' +
        detection.candidates.map((candidate) => `${candidate.target}: ${candidate.label}`).join("; ") +
        '), so none was picked automatically. Re-call with "target" and "device" to deliver to one ' +
        "of them, or use the QR below.",
    };
  }

  return {
    note:
      'No "target" was given and no booted iOS simulator or attached Android device was detected, ' +
      "so the link could not be delivered automatically. A physical iPhone/iPad is never " +
      'auto-detected: to deliver to one, re-call with target "ios-device" plus "bundleId" (needs ' +
      "iOS 17+, Xcode 15+ and a paired, trusted device with Developer Mode on) — otherwise use " +
      "the QR flow below.",
  };
};

export const handleConnectTool = async (
  rawArgs: unknown,
  deps: ConnectToolDeps,
): Promise<ConnectToolResult> => {
  const args = asRecord(rawArgs);

  const requestedTarget = asOptionalConnectTarget(args.target);
  const device = asOptionalNonEmptyString(args.device, "device");
  const bundleId = asOptionalNonEmptyString(args.bundleId, "bundleId");
  const relaunch = asOptionalBoolean(args.relaunch, "relaunch");
  const ttlSeconds = asOptionalPositiveNumber(args.ttlSeconds, "ttlSeconds");

  if (device !== undefined && (requestedTarget === undefined || requestedTarget === NO_TARGET)) {
    throw new McpBuiltinToolError(
      "invalid_request",
      '"device" requires an explicit "target" of "android", "ios-sim" or "ios-device" — a bare ' +
        "serial/udid does not say which platform it belongs to.",
    );
  }

  if (bundleId !== undefined && requestedTarget !== "ios-device") {
    throw new McpBuiltinToolError(
      "invalid_request",
      '"bundleId" only applies with target "ios-device".',
    );
  }

  if (relaunch !== undefined && requestedTarget !== "ios-device") {
    throw new McpBuiltinToolError(
      "invalid_request",
      '"relaunch" only applies with target "ios-device".',
    );
  }

  if (!deps.scheme) {
    throw new McpBuiltinToolError(
      "invalid_request",
      'A deep-link scheme is required: set "scheme" in config.json.',
    );
  }

  // Captured after the check so the closures below carry the narrowing (a mutable property does
  // not stay narrowed across one).
  const scheme = deps.scheme;

  const { delivery, note } = await resolveDelivery(requestedTarget, device, bundleId, deps);

  // Rejected before minting, so a call that cannot possibly deliver does not strand a pending
  // session behind it.
  if (delivery?.target === "ios-device" && !delivery.bundleId) {
    throw new McpBuiltinToolError("invalid_request", MISSING_BUNDLE_ID_MESSAGE);
  }

  if (delivery?.bundleId !== undefined && !isValidBundleId(delivery.bundleId)) {
    throw new McpBuiltinToolError("invalid_request", invalidBundleIdMessage(delivery.bundleId));
  }

  // A link's advertised address is fixed at mint time: `127.0.0.1` only when it is being handed to
  // something that reaches this machine over loopback (an emulator or simulator — not a physical
  // iPhone, which needs the LAN address). That is why delivery is decided first, and why the QR
  // fallback below has to mint a *fresh* link rather than reuse a loopback one no phone could reach.
  const mint = (deliverLocally: boolean): Promise<LinkCreateResult> => {
    return deps.call<LinkCreateResult>(RPC_METHODS.linkCreate, {
      ttlSeconds,
      addressOverride: deliverLocally ? OPEN_TARGET_ADDRESS_OVERRIDE : undefined,
    });
  };

  const asQrResult = (result: LinkCreateResult, qrNote?: string): ConnectToolResult => {
    const deepLink = composeDeepLink(scheme, result);

    return {
      sessionId: result.sessionId,
      deepLink,
      expiresAt: result.expiresAt,
      ...(qrNote === undefined ? {} : { note: qrNote }),
      qr: renderQrToTerminal(deepLink),
      instructions: QR_INSTRUCTIONS,
    };
  };

  if (!delivery) {
    return asQrResult(await mint(false), note);
  }

  const result = await mint(usesLoopbackAddress(delivery.target));

  // Same guard as `link.ts`: `detectAdvertisedAddress` falls back to `127.0.0.1` when it finds no
  // routable interface, and such a link points a physical phone at itself. Delivering it would
  // leave `cordierite_wait_for_session` blocking for its whole timeout with nothing to explain why.
  if (delivery.target === "ios-device" && isLoopbackAddress(result.endpoint.address)) {
    throw new McpBuiltinToolError(
      "invalid_request",
      loopbackAddressMessage(result.endpoint.address),
    );
  }

  const deepLink = composeDeepLink(scheme, result);

  try {
    await deliverToOpenTarget({
      target: delivery.target,
      device: delivery.device,
      bundleId: delivery.bundleId,
      relaunch,
      deepLink,
      wssPort: result.endpoint.port,
      exec: deps.exec,
      env: deps.env,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Failed to deliver the deep link.";

    // An explicitly named target that cannot be reached is the caller's problem to see: falling
    // back would quietly ignore what they asked for.
    if (!delivery.autoDetected) {
      throw new McpBuiltinToolError("tool_execution_error", detail);
    }

    // An auto-detected one is not. Nobody asked for this device — a simulator that happens to be
    // booted without the app installed, say — so a failure to reach it must not turn a call that
    // would previously have returned a usable QR into a hard error. The loopback link just minted
    // is abandoned (it expires on its own TTL) and a fresh, correctly-addressed one takes its
    // place.
    return asQrResult(
      await mint(false),
      `Auto-detected ${delivery.target} target ${delivery.label}, but delivering the link to it ` +
        `failed: ${detail}. Falling back to a QR code — pass an explicit "target" (and "device") ` +
        "if a different device is the right one.",
    );
  }

  return {
    sessionId: result.sessionId,
    deepLink,
    expiresAt: result.expiresAt,
    delivered: true,
    target: delivery.target,
    ...(delivery.device === undefined ? {} : { device: delivery.device }),
    ...(delivery.autoDetected
      ? {
          autoDetected: true as const,
          note: `No "target" was given; delivered to the only device found: ${delivery.label}.`,
        }
      : {}),
  };
};

/** Socket-level failures that mean the daemon went away mid-wait. `isDaemonUnreachableError`
 * covers the "never got there" cases (`ENOENT`/`ECONNREFUSED`) and a timed-out request; these are
 * the "was there, then wasn't" ones, which surface raw from a call that was already in flight. */
const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE"]);

/** Appends the underlying cause, so an operator reading CI output still gets the syscall detail
 * even though the sentence in front of it is what the agent acts on. */
const describeCause = (error: unknown): string => {
  return error instanceof Error && error.message.length > 0 ? ` (${error.message})` : "";
};

const daemonClosedMessage = (sessionId: string): string =>
  `The connection to the Cordierite daemon closed while waiting for session "${sessionId}".`;

const daemonUnreachableMessage = (sessionId: string, error: unknown): string =>
  `The Cordierite daemon is unreachable, so session "${sessionId}" cannot be waited on${describeCause(error)}.`;

const isConnectionLost = (error: unknown): boolean => {
  if (isDaemonUnreachableError(error)) {
    return true;
  }

  const code = (error as NodeJS.ErrnoException | null)?.code;

  return typeof code === "string" && CONNECTION_LOST_CODES.has(code);
};

export type WaitForSessionToolDeps = {
  stateDir: string;
  spawn?: SpawnFn;
};

export type WaitForSessionToolResult = {
  sessionId: string;
  claimed: true;
  alias: string;
};

export const handleWaitForSessionTool = async (
  rawArgs: unknown,
  deps: WaitForSessionToolDeps,
): Promise<WaitForSessionToolResult> => {
  const args = asRecord(rawArgs);

  if (typeof args.sessionId !== "string" || args.sessionId.length === 0) {
    throw new McpBuiltinToolError("invalid_request", '"sessionId" must be a non-empty string.');
  }

  const sessionId = args.sessionId;
  const timeoutMs = asOptionalPositiveNumber(args.timeoutMs, "timeoutMs") ?? DEFAULT_WAIT_TIMEOUT_MS;

  let stream: DaemonStream;

  try {
    stream = await openDaemonStream({ stateDir: deps.stateDir, spawn: deps.spawn });
  } catch (error) {
    // The daemon can be on its way out at the exact moment this tool opens its stream, in which
    // case `connect` fails with ECONNRESET — not the ENOENT/ECONNREFUSED that would mean "not
    // running" and trigger an auto-spawn. That is the same situation as losing it mid-wait, and
    // has to read the same way rather than as a bare syscall error against a socket path.
    if (isConnectionLost(error)) {
      throw new McpBuiltinToolError(
        "tool_execution_error",
        daemonUnreachableMessage(sessionId, error),
      );
    }

    throw error;
  }

  try {
    return await new Promise<WaitForSessionToolResult>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        unsubscribeNotification();
        unsubscribeClose();
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new McpBuiltinToolError(
              "tool_timeout",
              `Timed out after ${timeoutMs}ms waiting for session "${sessionId}" to be claimed.`,
            ),
          ),
        );
      }, timeoutMs);

      const connectionLost = (): McpBuiltinToolError =>
        new McpBuiltinToolError("tool_execution_error", daemonClosedMessage(sessionId));

      // A daemon that goes away mid-wait must not read as "still waiting" for the rest of the
      // timeout — the caller has to know the connection is gone, not sit in silence.
      const unsubscribeClose = stream.onClose(() => {
        settle(() => reject(connectionLost()));
      });

      // Registered *before* `events.subscribe` is sent (not after awaiting it) — a
      // `session_claimed` notification that arrives in the same TCP chunk as the subscribe
      // response is dispatched synchronously within that chunk's processing, before an `await`
      // continuation would get a chance to run; registering first means it is always in place in
      // time to see it. Same reasoning as `client/bootstrap.ts`.
      const unsubscribeNotification = stream.onNotification((payload) => {
        const event = payload as EventNotification;

        if (event.kind === "session_claimed" && event.sessionId === sessionId) {
          settle(() => resolve({ sessionId, claimed: true, alias: event.alias ?? "" }));
        }
      });

      stream
        .call(RPC_METHODS.eventsSubscribe, { sessionSelector: sessionId, kinds: ["session_claimed"] })
        .then(async () => {
          if (settled) {
            return;
          }

          // Catch-up, once the subscription is definitely in place: the session may have been
          // claimed before this tool ran at all (an agent polling, or a long gap after
          // cordierite_connect), or in the round trip the subscribe itself took. Either way the
          // event is already in the past and no amount of waiting will replay it.
          const existing = await stream.call<SessionsDescribeResult>(RPC_METHODS.sessionsDescribe, {
            selector: sessionId,
          });

          settle(() => resolve({ sessionId, claimed: true, alias: existing.alias }));
        })
        .catch((error: unknown) => {
          // `unknown_session` from the catch-up is the expected "not claimed yet" answer — keep
          // waiting for the live event. Anything else is a real failure.
          if (error instanceof DaemonRpcError && error.data?.type === "unknown_session") {
            return;
          }

          // A daemon dying mid-wait races two routes to get here: `onClose` above, or whichever
          // call was in flight rejecting with a raw socket error. Same condition, so report it the
          // same way — which route wins is a platform detail (Linux tends to reset where macOS
          // closes), and nobody should have to read `connect ECONNRESET <socket path>` to find out
          // the daemon stopped.
          settle(() => reject(isConnectionLost(error) ? connectionLost() : error));
        });
    });
  } finally {
    stream.close();
  }
};
