# Product Requirements

## Purpose

Cordierite lets React Native apps expose explicit, schema-described tools that can be invoked from a trusted external host over a pinned TLS session.

The product goal is to make app automation, diagnostics, and state control faster and more reliable than UI-only automation, without shipping hidden debug menus or creating anonymous remote access.

## Problem statement

UI-driven mobile automation is slow, brittle, and expensive to maintain. Many useful test, support, and diagnostics flows are easier to express as app-defined tools, but those tools need a secure transport and a clear trust model.

Cordierite provides that model by moving control outside the UI and exposing only the tool surface the app explicitly registers.

## Current product shape

Today the project consists of:

- a React Native client package: `@cordierite/react-native`
- a CLI and host package: `cordierite`
- a shared protocol and schema package: `@cordierite/shared`

The app imports the React Native package during startup, registers tools in JavaScript, and opens a pinned `wss://` connection back to the host after receiving a bootstrap deep link.

The host creates one pending session, accepts one active claimed session, mirrors the app's tool registry, and exposes local CLI operations to inspect and invoke tools.

## Goals

- Let React Native apps expose internal tools to external operators, tests, and agents.
- Keep the exposed surface explicit and allowlisted.
- Support development builds and production-capable app builds with the same basic model.
- Use pinned TLS and short-lived session bootstrap instead of hidden debug UI or trust in the local network.
- Support structured tool inputs, structured outputs, and structured errors.
- Make operator and automation workflows fast enough to replace many UI-driven helper flows.

## Non-goals

- Replacing all end-to-end UI testing.
- Allowing arbitrary code execution inside the app.
- Allowing anonymous or unauthenticated remote access.
- Treating deep links as proof of authority.
- Supporting multiple trusted host identities in the initial product.
- Supporting long-lived background sessions in the initial product.
- Providing fine-grained per-tool authorization in the initial product.

## Primary use cases

- Trigger deterministic app helpers without navigating the UI.
- Read internal app state that is hard to verify visually.
- Run support and QA flows against development, staging, or production-capable builds.
- Give agents a stable app-specific tool surface instead of screen scraping.
- Speed up repeated test and diagnostics actions inside a single authenticated session.

## Functional requirements

### 1. App-side tool runtime

- The app must be able to register tools in JavaScript.
- Every tool must have a stable name.
- Tools should support optional input and output schemas using the shared Standard Schema contract.
- Every tool must have an explicit handler.
- Only registered tools are exposed to the host.
- Tools must be removable at runtime.

### 2. Session bootstrap and connect

- The host must generate a bootstrap deep link containing a short-lived pending session.
- The app must be able to parse the bootstrap payload from the `cordierite` query parameter.
- The default React Native integration must install a startup-time deep-link listener automatically when the package is imported.
- The app must reject malformed or expired bootstrap payloads.
- The app should be able to require a private IPv4 bootstrap target.

### 3. Authentication and transport

- The app must connect to the host over `wss://`.
- The app must verify the host against embedded `sha256/...` SPKI pins.
- The host must use a certificate derived from the configured private key and advertised IPv4 address.
- Deep-link bootstrap data must not replace TLS-based host authentication.

### 4. Session establishment

- The host must create a pending session with a token, session id, endpoint, and expiry.
- The app must claim that pending session over the pinned socket using `session_claim`.
- The host must reject claims with wrong session ids, wrong tokens, expired sessions, or duplicate claims.
- The host must acknowledge successful claims with `session_ack`.
- The current runtime should allow at most one active claimed session per host instance.

### 5. Tool registry synchronization

- When the session becomes active, the app must send a full tool registry snapshot.
- When a tool is added or removed later, the app must send a registry delta.
- The host must keep a remote tool registry for the connected app so the CLI can inspect tools by name.

### 6. Tool invocation

- The host must be able to invoke a registered app tool with structured JSON args.
- Tool invocation must support request/response correlation.
- Tool results must return structured JSON-compatible data.
- Tool failures must return structured error payloads.
- The host should time out pending tool calls if the app does not respond.

### 7. Operator CLI

- The CLI must support generating a host key and app pin.
- The CLI must support starting the host and producing bootstrap session data.
- The CLI must support inspecting the current session state.
- The CLI must support listing tools and inspecting a named tool.
- The CLI must support invoking a tool with JSON input.
- The CLI should support machine-readable output with `--json`.

### 8. Observability

- Connection failures should be observable on both app and host sides.
- The app integration should expose bootstrap parse/connect failures through a listener API.
- The host should track session lifecycle and known remote tools in the local session registry.
- Logs and errors must avoid leaking raw secrets when possible.

## Security requirements

- The interface must be closed unless the app contains matching trusted pins and receives a valid bootstrap payload.
- The app must authenticate the host through TLS pinning.
- Bootstrap data alone must never be treated as sufficient trust.
- Pending sessions must expire quickly and should be single-use.
- The system must reject malformed session or tool messages safely.
- Only explicitly registered tools may be invoked.
- The trust anchor must be updateable by shipping new app configuration.

## Current implementation constraints

- The current React Native integration targets iOS and Android with the New Architecture.
- Web support is a safe stub only.
- Expo Go is not sufficient because native code and pin configuration are required.
- The default automatic bootstrap path ignores new deep links while the client is already `connecting` or `active`.
- The host currently exposes a local HTTP control API on `127.0.0.1` for the CLI.
- That local control API is currently unauthenticated, which is a known limitation.
- The default host flow is centered on IPv4 bootstrap endpoints.

## Reliability requirements

- Invalid bootstrap data must fail before a privileged session is established.
- Session state must be cleared when the connection closes or errors out.
- Tool failures must not crash the app integration.
- Stale pending sessions must expire automatically.
- CLI commands that target a missing or inactive session must fail clearly.

## Performance requirements

- Session setup should feel near-immediate in local development conditions.
- Tool invocation should be materially faster than equivalent UI automation for supported flows.
- The runtime should support repeated tool calls within a single authenticated session.

## Alignment with the current handshake

These requirements are intended to match the current implementation described in [HANDSHAKE.md](./HANDSHAKE.md).

At a product level that means:

- trust is anchored in app-configured pins
- bootstrap uses short-lived session payloads
- the app connects back to the host
- the host exposes only one active claimed session per runtime
- the tool surface is defined entirely by app code

## Open questions

- How should trusted pins be rotated across environments and app releases?
- Should production use gain an extra operator approval step for sensitive tools?
- How should the unauthenticated local control API be secured in a future version?
- Should future versions support multiple trusted host identities or remote relay scenarios?
- What audit trail is required for production incident response and compliance workflows?
