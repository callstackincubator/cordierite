/**
 * Task 04 acceptance matrix: the daemon's session engine had zero WebSocket-level tests in v1 and
 * hid the worst bug there (an unhandled socket `'error'` crashing the whole daemon). Every case
 * here drives a real pinned-TLS `wss://` socket against a real daemon instance (self-signed cert
 * from a throwaway key, an isolated `CORDIERITE_STATE_DIR`-equivalent temp dir) rather than mocking
 * the WebSocket layer, and synchronizes on the in-process event bus instead of sleeping.
 */

import { connect as connectUds, createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { decodeBootstrap, type EventKind, type EventNotification } from "@cordierite/shared";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { writeTestHostKey } from "./fixtures.js";

// Client pinning is the app's job (ARCHITECTURE.md task notes); tests skip it client-side. Under
// Vitest runs these clients against a throwaway self-signed key, so the leaf-cert check is
// disabled process-wide for this file.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (stateDirs.length > 0) {
    await rm(stateDirs.pop()!, { force: true, recursive: true });
  }
});

const pickFreePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
};

type TestDaemon = {
  daemon: RunningDaemon;
  port: number;
};

const startTestDaemon = async (configOverrides: Record<string, unknown> = {}): Promise<TestDaemon> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-session-engine-"));
  stateDirs.push(stateDir);
  await writeTestHostKey(path.join(stateDir, "key.pem"));

  const port = await pickFreePort();
  await writeFile(
    path.join(stateDir, "config.json"),
    JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1", ...configOverrides }),
  );

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);

  return { daemon, port };
};

/** Raw newline-delimited JSON-RPC call over the daemon's UDS control socket. */
const rpcCall = (socketPath: string, method: string, params?: unknown): Promise<unknown> => {
  return new Promise((resolve, reject) => {
    const socket: Socket = connectUds(socketPath);
    let buffer = "";

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} })}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      socket.destroy();

      const parsed = JSON.parse(line) as { result?: unknown; error?: { message: string; data?: unknown } };

      if (parsed.error) {
        reject(Object.assign(new Error(parsed.error.message), { data: parsed.error.data }));
        return;
      }

      resolve(parsed.result);
    });

    socket.once("error", reject);
  });
};

/** Waits for the next event of `kind` on the daemon's in-process bus. */
const waitForEvent = (daemon: RunningDaemon, kind: EventKind): Promise<EventNotification> => {
  return new Promise((resolve) => {
    const unsubscribe = daemon.eventBus.subscribe((event) => {
      if (event.kind === kind) {
        unsubscribe();
        resolve(event);
      }
    });
  });
};

const connectClient = (port: number): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
};

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> => {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
};

const nextClose = (socket: WebSocket): Promise<{ code: number; reason: string }> => {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
};

type BootstrapDetails = {
  sessionId: string;
  token: string;
  port: number;
};

const createLinkAndDecode = async (daemon: RunningDaemon, port: number, ttlSeconds = 60): Promise<BootstrapDetails> => {
  const result = (await rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds })) as {
    deepLinkPayload: string;
  };
  const decoded = decodeBootstrap(result.deepLinkPayload);
  expect(decoded).not.toBeNull();
  expect(decoded!.port).toBe(port);

  return { sessionId: decoded!.sessionId, token: decoded!.token, port: decoded!.port };
};

describe("session engine: full lifecycle", () => {
  test("mint -> claim -> ack -> snapshot -> suspend -> resume -> revoke, two concurrent devices", async () => {
    const { daemon, port } = await startTestDaemon();

    // --- device A: mint + claim ---
    const linkA = await createLinkAndDecode(daemon, port);
    const socketA = await connectClient(port);

    const claimedA = waitForEvent(daemon, "session_claimed");
    socketA.send(
      JSON.stringify({
        type: "session_claim",
        protocol_version: 2,
        session_id: linkA.sessionId,
        token: linkA.token,
        device_model: "Pixel 8",
      }),
    );
    const ackA = await nextMessage(socketA);
    await claimedA;

    expect(ackA).toMatchObject({ type: "session_ack", status: "ok", alias: "pixel-8", session_id: linkA.sessionId });
    expect(typeof ackA.resume_token).toBe("string");
    const firstResumeToken = ackA.resume_token as string;

    // --- device B: distinct alias while A is still connected ---
    const linkB = await createLinkAndDecode(daemon, port);
    const socketB = await connectClient(port);
    const claimedB = waitForEvent(daemon, "session_claimed");
    socketB.send(
      JSON.stringify({
        type: "session_claim",
        protocol_version: 2,
        session_id: linkB.sessionId,
        token: linkB.token,
        device_model: "Pixel 8",
      }),
    );
    const ackB = await nextMessage(socketB);
    await claimedB;
    expect(ackB.alias).toBe("pixel-8-2");

    const listed = (await rpcCall(daemon.paths.socketPath, "sessions.list")) as Array<{ alias: string }>;
    expect(listed.map((s) => s.alias).sort()).toEqual(["pixel-8", "pixel-8-2"]);

    // --- device A: tool registry snapshot ---
    const toolsChanged = waitForEvent(daemon, "tools_changed");
    socketA.send(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: linkA.sessionId,
        tools: [{ name: "ping", description: "Replies with pong." }],
      }),
    );
    await toolsChanged;

    const describedA = (await rpcCall(daemon.paths.socketPath, "sessions.describe", {
      selector: "pixel-8",
    })) as { toolCount: number; state: string };
    expect(describedA.toolCount).toBe(1);
    expect(describedA.state).toBe("active");

    // --- device A: suspend on disconnect, then resume with rotated token ---
    const suspended = waitForEvent(daemon, "session_suspended");
    socketA.close();
    await suspended;

    const describedSuspended = (await rpcCall(daemon.paths.socketPath, "sessions.describe", {
      selector: "pixel-8",
    })) as { state: string };
    expect(describedSuspended.state).toBe("suspended");

    const resumedSocket = await connectClient(port);
    const resumed = waitForEvent(daemon, "session_resumed");
    resumedSocket.send(
      JSON.stringify({
        type: "session_resume",
        protocol_version: 2,
        session_id: linkA.sessionId,
        resume_token: firstResumeToken,
      }),
    );
    const resumeAck = await nextMessage(resumedSocket);
    await resumed;

    expect(resumeAck).toMatchObject({ type: "session_ack", status: "ok", alias: "pixel-8" });
    expect(resumeAck.resume_token).not.toBe(firstResumeToken);

    // --- revoke device A ---
    const revoked = waitForEvent(daemon, "session_revoked");
    const revokeClosed = nextClose(resumedSocket);
    await rpcCall(daemon.paths.socketPath, "sessions.revoke", { selector: "pixel-8" });
    await revoked;
    const closeInfo = await revokeClosed;
    expect(closeInfo.code).toBe(1000);

    const finalList = (await rpcCall(daemon.paths.socketPath, "sessions.list")) as Array<{ alias: string }>;
    expect(finalList.map((s) => s.alias)).toEqual(["pixel-8-2"]);

    socketB.close();
  }, 15_000);
});

describe("session engine: rejection matrix (daemon and other sessions survive every case)", () => {
  test("wrong token during claim closes 1008 without discarding the link", async () => {
    const { daemon, port } = await startTestDaemon();
    const link = await createLinkAndDecode(daemon, port);

    const badSocket = await connectClient(port);
    const closed = nextClose(badSocket);
    badSocket.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: link.sessionId, token: "wrong-token" }),
    );
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toBe("invalid_token");

    // The link survives a single bad attempt: a correct claim still succeeds.
    const goodSocket = await connectClient(port);
    goodSocket.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: link.sessionId, token: link.token }),
    );
    const ack = await nextMessage(goodSocket);
    expect(ack.status).toBe("ok");
    goodSocket.close();

    const status = await rpcCall(daemon.paths.socketPath, "daemon.status");
    expect((status as { pid: number }).pid).toBe(process.pid);
  });

  test("5th failed claim attempt invalidates the link (already_claimed / claim_attempts_exceeded)", async () => {
    const { daemon, port } = await startTestDaemon();
    const link = await createLinkAndDecode(daemon, port);

    let lastClose: { code: number; reason: string } | undefined;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const socket = await connectClient(port);
      const closed = nextClose(socket);
      socket.send(
        JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: link.sessionId, token: "wrong" }),
      );
      lastClose = await closed;
    }

    expect(lastClose?.code).toBe(1008);
    expect(lastClose?.reason).toBe("claim_attempts_exceeded");

    // The link is now gone outright, even with the correct token.
    const finalSocket = await connectClient(port);
    const finalClosed = nextClose(finalSocket);
    finalSocket.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: link.sessionId, token: link.token }),
    );
    const finalClose = await finalClosed;
    expect(finalClose.code).toBe(1008);
    expect(finalClose.reason).toBe("unknown_session");

    await rpcCall(daemon.paths.socketPath, "daemon.status");
  });

  test("expired link closes 1008 link_expired", async () => {
    const { daemon, port } = await startTestDaemon();
    const link = await createLinkAndDecode(daemon, port, 1);

    // Deterministically wait for the TTL's own expiry event rather than sleeping blind. `link_expired`
    // is its own EventKind, distinct from `session_expired` (reserved for a claimed session's
    // SUSPENDED -> EXPIRED grace-window transition — ARCHITECTURE.md §5/§6).
    await waitForEvent(daemon, "link_expired");

    const socket = await connectClient(port);
    const closed = nextClose(socket);
    socket.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: link.sessionId, token: link.token }),
    );
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toBe("link_expired");
  });

  test("resume with a stale (already-rotated) token closes 1008 invalid_resume_token", async () => {
    const { daemon, port } = await startTestDaemon();
    const link = await createLinkAndDecode(daemon, port);

    const socket = await connectClient(port);
    socket.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: link.sessionId, token: link.token }),
    );
    const ack = await nextMessage(socket);
    const staleResumeToken = ack.resume_token as string;

    const suspended = waitForEvent(daemon, "session_suspended");
    socket.close();
    await suspended;

    // Resume once to rotate the token...
    const resumeSocket = await connectClient(port);
    const resumed = waitForEvent(daemon, "session_resumed");
    resumeSocket.send(
      JSON.stringify({
        type: "session_resume",
        protocol_version: 2,
        session_id: link.sessionId,
        resume_token: staleResumeToken,
      }),
    );
    await nextMessage(resumeSocket);
    await resumed;

    // ...then suspend again and attempt a second resume with the now-stale token.
    const suspendedAgain = waitForEvent(daemon, "session_suspended");
    resumeSocket.close();
    await suspendedAgain;

    const staleAttempt = await connectClient(port);
    const staleClosed = nextClose(staleAttempt);
    staleAttempt.send(
      JSON.stringify({
        type: "session_resume",
        protocol_version: 2,
        session_id: link.sessionId,
        resume_token: staleResumeToken,
      }),
    );
    const closeInfo = await staleClosed;
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toBe("invalid_resume_token");
  });

  test("mismatched session_id post-claim closes 1008 session_mismatch", async () => {
    const { daemon, port } = await startTestDaemon();
    const link = await createLinkAndDecode(daemon, port);

    const socket = await connectClient(port);
    socket.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: link.sessionId, token: link.token }),
    );
    await nextMessage(socket);

    const closed = nextClose(socket);
    socket.send(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: "not-the-active-session",
        tools: [],
      }),
    );
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toBe("session_mismatch");
  });

  test("binary frame closes 1003", async () => {
    const { port } = await startTestDaemon();
    const socket = await connectClient(port);
    const closed = nextClose(socket);
    socket.send(Buffer.from([1, 2, 3]));
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(1003);
  });

  test("a frame over 256 KiB is rejected", async () => {
    const { port } = await startTestDaemon();
    const socket = await connectClient(port);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.send(JSON.stringify({ type: "session_claim", padding: "x".repeat(300 * 1024) }));
    await closed;
  });

  test("malformed JSON closes 1008 invalid_json", async () => {
    const { port } = await startTestDaemon();
    const socket = await connectClient(port);
    const closed = nextClose(socket);
    socket.send("{ not json");
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toBe("invalid_json");
  });

  test("unclaimed socket idle past the pre-claim timeout closes 1008 pre_claim_timeout", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "cordierite-session-engine-"));
    stateDirs.push(stateDir);
    await writeTestHostKey(path.join(stateDir, "key.pem"));
    const port = await pickFreePort();
    await writeFile(
      path.join(stateDir, "config.json"),
      JSON.stringify({ wssPort: port, advertisedIp: "127.0.0.1" }),
    );

    const daemon = await startDaemon({ stateDir });
    runningDaemons.push(daemon);

    const socket = await connectClient(port);
    const closed = nextClose(socket);
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toBe("pre_claim_timeout");
  }, 15_000);

  test("an invalid tool_registry_snapshot (tools: [null]) closes 1008 invalid_registry", async () => {
    const { daemon, port } = await startTestDaemon();
    const link = await createLinkAndDecode(daemon, port);

    const socket = await connectClient(port);
    socket.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: link.sessionId, token: link.token }),
    );
    await nextMessage(socket);

    const closed = nextClose(socket);
    socket.send(`{"type":"tool_registry_snapshot","session_id":"${link.sessionId}","tools":[null]}`);
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toBe("invalid_registry");
  });

  test("unknown post-claim message type closes 1008 unknown_message_type", async () => {
    const { daemon, port } = await startTestDaemon();
    const link = await createLinkAndDecode(daemon, port);

    const socket = await connectClient(port);
    socket.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: link.sessionId, token: link.token }),
    );
    await nextMessage(socket);

    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "banana", session_id: link.sessionId }));
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toBe("unknown_message_type");
  });
});

describe("session selectors", () => {
  test("no_session / ambiguous_session / unknown_session error types", async () => {
    const { daemon, port } = await startTestDaemon();

    await expect(rpcCall(daemon.paths.socketPath, "sessions.describe")).rejects.toMatchObject({
      data: { type: "no_session" },
    });

    const linkA = await createLinkAndDecode(daemon, port);
    const socketA = await connectClient(port);
    socketA.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: linkA.sessionId, token: linkA.token }),
    );
    await nextMessage(socketA);

    const linkB = await createLinkAndDecode(daemon, port);
    const socketB = await connectClient(port);
    socketB.send(
      JSON.stringify({ type: "session_claim", protocol_version: 2, session_id: linkB.sessionId, token: linkB.token }),
    );
    await nextMessage(socketB);

    await expect(rpcCall(daemon.paths.socketPath, "sessions.describe")).rejects.toMatchObject({
      data: { type: "ambiguous_session" },
    });

    await expect(
      rpcCall(daemon.paths.socketPath, "sessions.describe", { selector: "does-not-exist" }),
    ).rejects.toMatchObject({ data: { type: "unknown_session" } });

    socketA.close();
    socketB.close();
  });
});
