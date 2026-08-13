# Product Requirements

This document describes the v2 product shape (the daemon-based refactor). See
`docs/ARCHITECTURE.md` for the technical specification and `docs/PROTOCOL.md` for the
wire-level detail; this document stays at the product-requirements level.

## Purpose

Cordierite lets React Native apps expose explicit, schema-described tools that can be
invoked from a trusted external operator or agent over a pinned TLS session.

The product goal is to make app automation, diagnostics, and state control faster and
more reliable than UI-only automation, without shipping hidden debug menus or creating
anonymous remote access.

## Problem statement

UI-driven mobile automation is slow, brittle, and expensive to maintain. Many useful
test, support, and diagnostics flows are easier to express as app-defined tools, but
those tools need a secure transport, a clear trust model, and — as soon as more than one
device or more than one churn event (a Metro reload, background transition, or network
flap) enters the picture — a session model that survives that churn without operator
intervention.

Cordierite provides that model by moving control outside the UI, exposing only the tool
surface the app explicitly registers, and running a long-lived local daemon that absorbs
device churn instead of requiring a fresh daemon process and deep link every time. The
app resume lease is process-memory-only, so native app process death still requires a
fresh bootstrap.

## Current product shape

The project consists of:

- `@cordierite/react-native` — the app-side native client. Apps register tools in
  JavaScript and open a pinned `wss://` connection back to the daemon after a bootstrap
  deep link (or the emulator/simulator fast path) delivers session parameters.
- `cordierite` — the CLI, the daemon, and the MCP server, all in one package. The daemon
  is the only process that holds the private key and the `wss://` listener; the CLI and
  the MCP server are thin RPC clients of it over a Unix domain socket, and both
  transparently auto-spawn the daemon on first use.
- `@cordierite/shared` — the wire protocol v2 types, RPC types, bootstrap codec, and
  Standard Schema helpers used by every other package.

One daemon per operator machine serves any number of concurrent device sessions on a
single `wss://` port. `cordierite` (CLI) and `cordierite mcp` (MCP server) are both thin
clients of the same daemon RPC surface — a human operator and an agent see the same
tools, through the same session model, with the same policy and audit applied.

## Goals

- Let React Native apps expose internal tools to external operators, tests, and agents.
- Keep the exposed surface explicit and allowlisted — only what the app registers.
- Survive the churn a real dev loop produces (Metro reloads, backgrounding, and network
  flaps) without requiring a new daemon process or a new deep link for a reconnect within
  the grace window while the native app process stays alive.
- Serve multiple concurrent devices from one daemon process.
- Make MCP the primary machine-consumption surface (`cordierite mcp` in a Claude
  Code/Cursor-style MCP config) while keeping the CLI as the human-first surface — both
  thin clients of the same daemon.
- Harden the local control plane: a Unix-domain-socket RPC surface guarded by filesystem
  permissions, not an unauthenticated localhost TCP API.
- Support development builds and production-capable app builds with the same
  architecture: production adds policy (allow/deny per tool, per destructive-hint class)
  and audit, not a different transport or trust model.
- Support structured tool inputs, structured outputs, and structured errors, with error
  types preserved verbatim end-to-end (daemon → RPC → CLI/MCP output).

## Non-goals

- Replacing all end-to-end UI testing.
- Allowing arbitrary code execution inside the app — only pre-registered, named tools.
- Allowing anonymous or unauthenticated remote access.
- Treating deep links as proof of authority.
- Interactive consent prompting for individual tool calls (v2.0 — the policy enum
  reserves a future `"prompt"` value; see "Resolved in v2" below for what *is* in scope).
- Remote relay to hosts outside the operator machine.
- Pinning an offline anchor CA that signs short-lived leaf certs (the current model pins
  the same key used for the TLS leaf; overlapping pin-sets are the supported rotation
  path — see `docs/SECURITY.md`).

## Primary use cases

- Trigger deterministic app helpers without navigating the UI.
- Read internal app state that is hard to verify visually.
- Run support and QA flows against development, staging, or production-capable builds.
- Give agents (via MCP) a stable, app-specific, schema-described tool surface instead of
  screen scraping — including bootstrapping a device session end-to-end
  (`cordierite_connect` + `cordierite_wait_for_session`) without shell access.
- Speed up repeated test and diagnostics actions across many sessions and reconnects
  without restarting anything.

## Functional requirements

### 1. App-side tool runtime

- The app registers tools in JavaScript with `registerTool` / `useCordieriteTool`.
- Every tool has a stable, unique-per-session name (`[a-zA-Z0-9_-]{1,64}`).
- Tools support optional input/output schemas via the shared Standard Schema contract,
  and optional annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) that
  drive daemon-side policy.
- Every tool has an explicit handler; only registered tools are exposed to the daemon.
- Tools are removable at runtime; the disposer removes only its own registration.
- An app can compile Cordierite's native code out of a build entirely by excluding it from
  autolinking, and its JS out via the `/noop` entry point — two independent, combinable
  mechanisms, neither implied by build type (debug/release) on its own. See
  `docs/ARCHITECTURE.md` §11 and `docs/SECURITY.md`'s "Compile out of a build you don't want
  carrying Cordierite at all".

### 2. Session bootstrap and connect

- The daemon mints a bootstrap deep link containing a short-lived pending session
  (`cordierite link`, or the MCP `cordierite_connect` tool).
- The app parses the v2 bootstrap payload from the `cordierite` query parameter, or the
  operator delivers it directly to a booted emulator/simulator without any deep link UX
  (`cordierite link --open android|ios-sim`).
- The default React Native integration installs a startup-time deep-link listener when
  `@cordierite/react-native/auto` is imported (opt-in, unlike v1's implicit root-import
  behavior).
- The app rejects malformed or expired bootstrap payloads and a v1-format payload
  outright (no fallback).
- The app can require a private/local bootstrap target (`allowPrivateLanOnly`).

### 3. Authentication and transport

- The app connects to the daemon over `wss://`.
- The app verifies the daemon against an embedded set of `sha256/...` SPKI pins (a set,
  not a single pin, to support rotation without a flag day).
- The daemon uses a certificate derived from its configured private key and the
  resolved/advertised address.
- Deep-link bootstrap data never replaces TLS-based daemon authentication.

### 4. Session establishment and lifecycle

- The daemon creates a pending session with a token, session id, endpoint, and expiry.
- The app claims that pending session with `session_claim` over the pinned socket.
- The daemon rejects claims with wrong session ids, wrong tokens (`timingSafeEqual`
  comparison), expired sessions, or a 6th attempt after 5 consecutive failures.
- The daemon acknowledges successful claims with `session_ack`, including a rotating
  `resume_token`.
- On socket loss the session suspends (not terminates) and can resume with
  `session_resume` within a configurable grace window, without a new deep link.
- The native client stores the latest acknowledged resume lease in process memory only,
  before JS observes the acknowledgement. The grace window is measured from transport
  suspension/disconnection, not acknowledgement time. A fresh Metro runtime restores
  that lease automatically when bootstrap installation starts; native process death
  erases it and requires a fresh bootstrap.
- The daemon serves any number of concurrent sessions, each independently claimable,
  suspendable, and resumable; sessions never collide on id or alias.

### 5. Tool registry synchronization

- When a session becomes active (claim or resume), the app sends a full tool registry
  snapshot; every element is validated before the daemon indexes into it.
- When a tool is added or removed later, the app sends a registry delta.
- The daemon keeps a per-session tool registry so the CLI/MCP can inspect and invoke
  tools by name (or namespaced `<alias>__<name>` when multiple sessions are active over
  MCP).

### 6. Tool invocation

- The daemon invokes a registered app tool with structured JSON args, correlated by a
  call id.
- Tool results and errors are structured JSON; error types are one of a fixed, shared
  enum and are preserved verbatim end-to-end.
- Long-running calls can report progress (`tool_call_progress`) before resolving.
- The daemon times out a pending call after a configurable timeout; the app itself times
  out a handler that outlives that hint and replies `tool_timeout`, ignoring any later
  result.
- Every call — regardless of outcome — is subject to policy (§ below) and is audited.

### 7. Operator CLI and MCP server

- The CLI generates a daemon key and app pin (`keygen`), non-interactively when
  `--out` is given (unlike v1's TTY-only flow).
- The CLI mints bootstrap links (`link`), lists sessions (`ls`), lists/inspects tools
  (`tools`), invokes tools (`invoke`), streams events (`events`), revokes sessions
  (`revoke`), and manages the daemon (`daemon run|start|stop|status`).
- Every command works without a session selector when exactly one session is live, and
  with an explicit selector (session id or alias) when several are.
- The CLI supports machine-readable output with `--json` (NDJSON for streaming
  commands).
- `cordierite mcp` starts a stdio MCP server exposing the same tool surface as
  `tools/list`/`tools/call`, plus `cordierite_connect` and `cordierite_wait_for_session`
  for bootstrapping a session from inside an agent conversation.

### 8. Observability

- Connection failures are observable on both app (`addCordieriteListener("error", ...)`)
  and daemon (`cordierite events`, `events.subscribe`) sides.
- The daemon tracks session lifecycle, tool registry changes, and app-originated events
  through one unified event bus, consumable by the CLI, MCP notifications, or any future
  consumer of `events.subscribe`.
- Every `tools.call` attempt is appended to an audit log with a hash of its args, never
  the raw args.
- `daemon.status` surfaces effective policy configuration and audit write-failure counts
  so an operator can confirm both are actually active.

## Security requirements

- The interface is closed unless the app holds matching trusted pins and receives a
  valid bootstrap payload.
- The app authenticates the daemon through TLS pinning; bootstrap data alone is never
  treated as sufficient trust.
- Pending sessions expire quickly and are single-use; the control-plane socket is
  filesystem-permission-gated (`0700`/`0600`), not open on any network interface.
- The system rejects malformed session, registry, or tool messages without crashing or
  indexing into unvalidated data.
- Only explicitly registered tools may be invoked, and policy can deny classes of tool
  (by `destructiveHint`) or specific tools outright before a call ever reaches the app.
- The trust anchor is updateable by shipping new app configuration; pin sets (not single
  pins) make that update non-breaking for already-shipped builds.

## Resolved in v2

These were open questions in the v1 requirements document; the daemon refactor resolves
them:

- **Local API auth.** The v1 local control API was unauthenticated TCP on `127.0.0.1`.
  v2 replaces it with a Unix domain socket under a `0700` state directory, itself
  `0600` — see `docs/SECURITY.md`'s "localhost/UDS trust boundary" section.
- **Reconnection.** v1 had no session survival story: any socket loss ended the session.
  v2's suspend/resume state machine (`docs/PROTOCOL.md` §6) with a rotating resume token
  and a configurable grace window lets an app recover from a Metro reload, a background/
  foreground cycle, or a network flap without a new deep link while its native process
  stays alive. The lease is not persisted, so process death requires a fresh bootstrap.
- **Multi-host / multi-device.** v1 ran one host process per device with one active
  claimed session. v2 runs one daemon serving any number of concurrent device sessions
  on the same `wss://` port.

## Genuinely open questions

- **Anchor-CA rotation.** The current model pins the same key used to sign the TLS leaf;
  an offline anchor CA that signs short-lived leaves would decouple "the key the app
  pins" from "the key that must stay online," but is deferred (`docs/ARCHITECTURE.md`
  §14) — overlapping pin-sets are the supported rotation path for now.
- **Interactive consent.** Per-call human approval for destructive tools is reserved in
  the policy enum (a future `"prompt"` value) but not implemented; today policy is a
  static allow/deny decided by `config.json`, not an interactive prompt.
- **Relay.** Reaching a device that isn't reachable from the operator's machine (no
  shared LAN, no port-forwarded/public endpoint) has no supported story; the deep link
  and the `wss://` listener both assume the operator machine is directly reachable by
  the device it's talking to.
