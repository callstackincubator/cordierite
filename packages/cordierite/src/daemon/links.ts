/**
 * Pending-link minting (ARCHITECTURE.md §6 PENDING state, §8 bootstrap payload). A link is a
 * short-lived, single-use claim ticket: `sessionId` + `token`, encoded into the deep-link
 * bootstrap payload and backed by a TTL timer that discards it if nobody claims it in time.
 * Pending links are cheap and re-issuable — they are never persisted and never appear in
 * `sessions.list`/`sessions.describe` (only claimed sessions do; see sessions.ts).
 */

import { randomBytes } from "node:crypto";

import { encodeBootstrap, type AgentEndpoint } from "@cordierite/shared";

import type { Clock } from "../cli/types.js";
import type { EventBus } from "./event-bus.js";
import type { TimerFns, TimerHandle } from "./timers.js";

const SESSION_ID_BYTES = 12;
const TOKEN_BYTES = 32;

export type PendingLink = {
  sessionId: string;
  /** Raw 32-byte token; compared with `crypto.timingSafeEqual`, never logged. */
  token: Buffer;
  createdAt: Date;
  expiresAt: Date;
};

export type CreatedLink = {
  link: PendingLink;
  deepLinkPayload: string;
  endpoint: AgentEndpoint;
};

export type PendingLinkRegistryOptions = {
  /** Resolves the current advertised endpoint at mint time (address may be re-detected). */
  getEndpoint: () => AgentEndpoint;
  clock: Clock;
  timers: TimerFns;
  eventBus: EventBus;
};

export type PendingLinkRegistry = {
  create: (ttlSeconds: number) => CreatedLink;
  /** Looks up a pending link without consuming it (used to distinguish "unknown" from "already claimed"). */
  get: (sessionId: string) => PendingLink | undefined;
  /** Removes and returns the link (successful claim consumes its single use). */
  consume: (sessionId: string) => PendingLink | undefined;
  /** Records a failed claim attempt; returns the attempt count so far. */
  recordFailedAttempt: (sessionId: string) => number;
  /** Discards a link outright (TTL expiry, attempt-limit exceeded, or explicit revoke). */
  discard: (sessionId: string) => void;
  /** Clears every outstanding TTL timer (daemon shutdown). */
  disposeAll: () => void;
};

const generateSessionId = (): string => {
  // Re-rolled if it starts with "-": v1 ids starting with "-" broke CLI flag parsing
  // (e.g. `cordierite tools -abc123...` was parsed as a flag, not a selector).
  let candidate = randomBytes(SESSION_ID_BYTES).toString("base64url");

  while (candidate.startsWith("-")) {
    candidate = randomBytes(SESSION_ID_BYTES).toString("base64url");
  }

  return candidate;
};

type InternalRecord = {
  link: PendingLink;
  attempts: number;
  timer: TimerHandle;
};

export const createPendingLinkRegistry = (options: PendingLinkRegistryOptions): PendingLinkRegistry => {
  const records = new Map<string, InternalRecord>();

  const discard = (sessionId: string): void => {
    const record = records.get(sessionId);

    if (!record) {
      return;
    }

    options.timers.clearTimeout(record.timer);
    records.delete(sessionId);
  };

  return {
    create: (ttlSeconds) => {
      const sessionId = generateSessionId();
      const token = randomBytes(TOKEN_BYTES);
      const createdAt = options.clock.now();
      const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
      const endpoint = options.getEndpoint();

      // Deliberately does not delete the record: a claim attempt arriving just after the timer
      // fires must still see the (now-expired) link and be told "expired" rather than "unknown" —
      // the distinction the rejection matrix requires. `handleClaim`'s own `expiresAt` check
      // discards the record (and reports `link_expired`) the next time anything touches it;
      // `disposeAll` clears every outstanding record (and its timer) on daemon shutdown.
      const timer = options.timers.setTimeout(() => {
        options.eventBus.emit({ kind: "session_expired", sessionId, data: { reason: "link_ttl_expired" } });
      }, ttlSeconds * 1000);

      const link: PendingLink = { sessionId, token, createdAt, expiresAt };
      records.set(sessionId, { link, attempts: 0, timer });

      const deepLinkPayload = encodeBootstrap({
        ...endpoint,
        sessionId,
        token: token.toString("base64url"),
        expiresAt: Math.floor(expiresAt.getTime() / 1000),
      });

      options.eventBus.emit({ kind: "link_created", sessionId, data: { expiresAt: link.expiresAt.toISOString() } });

      return { link, deepLinkPayload, endpoint };
    },
    get: (sessionId) => records.get(sessionId)?.link,
    consume: (sessionId) => {
      const record = records.get(sessionId);

      if (!record) {
        return undefined;
      }

      options.timers.clearTimeout(record.timer);
      records.delete(sessionId);
      return record.link;
    },
    recordFailedAttempt: (sessionId) => {
      const record = records.get(sessionId);

      if (!record) {
        return 0;
      }

      record.attempts += 1;
      return record.attempts;
    },
    discard,
    disposeAll: () => {
      for (const sessionId of Array.from(records.keys())) {
        discard(sessionId);
      }
    },
  };
};
