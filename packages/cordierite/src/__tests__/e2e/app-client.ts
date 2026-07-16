/**
 * Task 16 scope item 1: a scripted app client — `claim(link)`, `resume()`, `registerTools([...])`,
 * `answerCalls(handler)`, `emitEvent(...)`, `dropSocket()` — that verifies the daemon's SPKI pin
 * before ever trusting the connection, the same trust decision a real app SDK makes
 * (ARCHITECTURE.md §2/§7). Every wire frame is sent verbatim (protocol v2, ARCHITECTURE.md §7); no
 * daemon internals are imported.
 */

import WebSocket from "ws";

import type { ToolDescriptor } from "@cordierite/shared";

import { verifyServerPin, type DecodedLink } from "./harness.js";

type Ack = {
  type: "session_ack";
  session_id: string;
  status: "ok";
  alias: string;
  resume_token: string;
  keepalive_interval_s: number;
  grace_s: number;
};

type ToolCallFrame = { type: "tool_call"; session_id: string; id: string; name: string; args: Record<string, unknown> };

export type ToolCallHandler = (
  call: ToolCallFrame,
) =>
  | { result: unknown }
  | { error: { type: string; message: string; details?: unknown } }
  | Promise<{ result: unknown } | { error: { type: string; message: string; details?: unknown } }>;

export type CloseInfo = { code: number; reason: string };

/** A scripted fake device app. One instance == one device's live connection lifecycle (it may hold
 * zero or one open socket at a time; `resume()` opens a fresh one). */
export class FakeAppClient {
  private socket: WebSocket | undefined;
  private toolCallHandler: ToolCallHandler | undefined;
  private closeWaiters: Array<(info: CloseInfo) => void> = [];

  sessionId = "";
  alias = "";
  resumeToken = "";

  constructor(
    private readonly port: number,
    private readonly pinnedKeys: readonly string[],
  ) {}

  /** Verifies the daemon's SPKI pin, then claims `link` over a fresh pinned `wss://` connection. */
  async claim(link: DecodedLink, device: { model?: string; manufacturer?: string; os?: string } = {}): Promise<Ack> {
    await verifyServerPin(this.port, this.pinnedKeys);

    const socket = await this.connect();
    const ackPromise = this.nextMessage<Ack>(socket);

    socket.send(
      JSON.stringify({
        type: "session_claim",
        protocol_version: 2,
        session_id: link.sessionId,
        token: link.token,
        device_manufacturer: device.manufacturer,
        device_model: device.model,
        device_os: device.os,
      }),
    );

    const ack = await ackPromise;
    this.sessionId = link.sessionId;
    this.alias = ack.alias;
    this.resumeToken = ack.resume_token;
    this.attach(socket);

    return ack;
  }

  /** Verifies the pin again, then resumes on a fresh connection using the last-known resume token. */
  async resume(): Promise<Ack> {
    if (!this.sessionId || !this.resumeToken) {
      throw new Error("FakeAppClient.resume() called before a successful claim().");
    }

    await verifyServerPin(this.port, this.pinnedKeys);

    const socket = await this.connect();
    const ackPromise = this.nextMessage<Ack>(socket);

    socket.send(
      JSON.stringify({
        type: "session_resume",
        protocol_version: 2,
        session_id: this.sessionId,
        resume_token: this.resumeToken,
      }),
    );

    const ack = await ackPromise;
    this.resumeToken = ack.resume_token;
    this.attach(socket);

    return ack;
  }

  /** Sends an authoritative `tool_registry_snapshot`. Does not itself wait for the daemon to have
   * processed it (this client has no visibility into daemon internals) — callers synchronize on a
   * `tools_changed` event or a subsequent state read that has to reflect it. */
  registerTools(tools: Array<Partial<ToolDescriptor> & { name: string }>): void {
    this.requireSocket().send(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: this.sessionId,
        tools: tools.map((tool) => ({ description: "A scripted test tool.", ...tool })),
      }),
    );
  }

  /** Installs a handler that answers every `tool_call` frame received from here on. */
  answerCalls(handler: ToolCallHandler): void {
    this.toolCallHandler = handler;
  }

  /** Emits an app-originated `event` frame. */
  emitEvent(name: string, payload?: unknown): void {
    this.requireSocket().send(
      JSON.stringify({ type: "event", session_id: this.sessionId, name, payload, ts: Date.now() }),
    );
  }

  /** Sends a raw frame verbatim — for hostility scenarios that need malformed/garbage content. */
  sendRaw(data: string | Buffer): void {
    this.requireSocket().send(data);
  }

  /** Drops the current socket without a clean close (simulates a network flap / crash), the exact
   * trigger for ACTIVE -> SUSPENDED (ARCHITECTURE.md §6). */
  dropSocket(): void {
    this.requireSocket().terminate();
    this.socket = undefined;
  }

  /** Closes the current socket cleanly (code 1000). */
  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  /** Resolves the next close of whatever the currently-connected socket is (or the next socket to
   * connect and then close, if called before `claim`/`resume`). */
  waitForClose(): Promise<CloseInfo> {
    return new Promise((resolve) => {
      this.closeWaiters.push(resolve);
    });
  }

  private requireSocket(): WebSocket {
    if (!this.socket) {
      throw new Error("FakeAppClient has no open socket — call claim()/resume() first.");
    }

    return this.socket;
  }

  private connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      // `rejectUnauthorized: false` here is the Bun `ws`-shim workaround documented in harness.ts;
      // the real trust decision already happened in `verifyServerPin` above.
      const socket = new WebSocket(`wss://127.0.0.1:${this.port}`, { rejectUnauthorized: false });
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  private attach(socket: WebSocket): void {
    this.socket = socket;

    socket.on("message", (data) => {
      let message: Record<string, unknown>;

      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      if (message.type === "tool_call" && this.toolCallHandler) {
        void this.handleToolCall(socket, message as unknown as ToolCallFrame);
      }
    });

    socket.on("close", (code, reason) => {
      const info: CloseInfo = { code, reason: reason.toString("utf8") };
      const waiters = this.closeWaiters;
      this.closeWaiters = [];

      for (const waiter of waiters) {
        waiter(info);
      }
    });

    // A socket-level 'error' must never go unhandled (the exact v1 defect this test suite exists
    // to catch on the daemon side); on the client side, an unhandled 'error' would just crash this
    // test process, so it's swallowed here — 'close' still fires and drives the fixture's own state.
    socket.on("error", () => {});
  }

  private async handleToolCall(socket: WebSocket, call: ToolCallFrame): Promise<void> {
    const outcome = await this.toolCallHandler!(call);

    if ("error" in outcome) {
      socket.send(JSON.stringify({ type: "tool_error", session_id: this.sessionId, id: call.id, error: outcome.error }));
    } else {
      socket.send(JSON.stringify({ type: "tool_result", session_id: this.sessionId, id: call.id, result: outcome.result }));
    }
  }

  private nextMessage<T>(socket: WebSocket): Promise<T> {
    return new Promise((resolve, reject) => {
      socket.once("message", (data) => {
        try {
          resolve(JSON.parse(data.toString("utf8")) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
