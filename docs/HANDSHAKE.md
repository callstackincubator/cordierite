# Cordierite Handshake And Session Flow

## Overview

Cordierite lets a React Native app connect back to a trusted host over pinned `wss://`, claim a short-lived session, and then exchange tool registry and tool invocation messages on that same connection.

This document describes the current protocol and operator flow implemented in the repo today.

## Security model

- The app does **not** trust the deep link by itself.
- The app does **not** trust the local network, IP address, or URL origin by itself.
- The app trusts the host only if the presented TLS identity matches an embedded `sha256/...` SPKI pin.
- The deep link carries bootstrap data for one pending session.
- The session token is short-lived and single-use.

Today, the app is the TLS client and the Cordierite host is the TLS WebSocket server.

## Current high-level flow

```text
Operator runs `cordierite host`
Host generates a certificate from the configured private key and advertised IPv4 address
Host creates one pending session with a short TTL
Host prints a bootstrap deep link
App opens the deep link
App parses the `cordierite` query payload and calls connect
App verifies the host's TLS identity against embedded SPKI pins
App sends `session_claim`
Host validates and consumes the pending session token
Host sends `session_ack`
App syncs the registered tool registry
Operator lists or invokes tools through the host control API via the CLI
```

## Bootstrap deep link

The deep link format is:

```text
<scheme>:///?cordierite=<base64url-binary-v1>
```

The `cordierite` query value must be the binary v1 wire payload encoded as base64url without padding.

### Binary v1 payload

The current wire format is:

- `0x01` version byte
- 4-byte IPv4 address, big-endian
- 2-byte port, big-endian
- 1-byte UTF-8 `sessionId` length, then `sessionId` bytes
- 32 raw token bytes
- 4-byte `expiresAt` unix seconds, big-endian

The React Native client accepts only this binary v1 form.

## App-side bootstrap behavior

Importing `@cordierite/react-native` installs the default deep-link bootstrap handler. That handler:

- watches incoming URLs for a `cordierite` query parameter
- ignores non-Cordierite URLs
- skips bootstrap if the client is already `connecting` or `active`
- parses and validates the bootstrap payload
- calls `connect(...)` on the default Cordierite client

By default, the automatic bootstrap path requires a private IPv4 host unless native configuration disables that restriction.

If parsing or connect fails, `addCordieriteErrorListener(...)` receives an event with:

- `phase: "parse" | "connect"`
- `url`
- `error`

## Host-side session setup

`cordierite host` currently does all of the following:

- reads a PEM private key from `--tls-key`
- resolves the advertised host IP from `--ip`, or auto-detects one
- uses `127.0.0.1` as the advertised IP when `--open` is used for simulator flow
- generates a leaf certificate from the private key and advertised IP
- creates one pending session with:
  - `session_id`
  - `token`
  - `ip`
  - `port`
  - `expires_at`
  - `status: "pending"`
- starts the TLS WebSocket host on the advertised port
- starts a separate local HTTP control server on `127.0.0.1` and an ephemeral port

Default values today:

- `--port`: `8443`
- `--ttl`: `60` seconds

## Session claim message

After the app establishes the pinned `wss://` connection, it sends:

```json
{
  "type": "session_claim",
  "session_id": "abc123",
  "token": "base64url-random-32-bytes"
}
```

The app may also include optional device metadata:

```json
{
  "type": "session_claim",
  "session_id": "abc123",
  "token": "base64url-random-32-bytes",
  "device_manufacturer": "Apple",
  "device_model": "iPhone15,2",
  "device_os": "iOS 18.2"
}
```

Current validation rules:

- device fields are optional
- each device field must be a string
- each device field must be at most 256 characters
- invalid device field values cause claim rejection

## Host claim validation

The host accepts the claim only if all of the following are true:

- there is not already an active claimed socket
- the pending session is still claimable
- the `session_id` matches the pending session
- the `token` matches the pending session token
- the token has not expired

On success, the host:

- marks the session as `active`
- clears the pending-session TTL timer
- sends a session acknowledgement
- emits session events for reporting and registry persistence

On failure, the host closes the socket with a policy error reason.

## Session acknowledgement

On successful claim, the host responds with:

```json
{
  "type": "session_ack",
  "session_id": "abc123",
  "status": "ok"
}
```

After that point, all later protocol messages must be bound to the same `session_id`.

## Post-claim protocol messages

The current message set is:

### Tool registry snapshot

Sent by the app when the session becomes active so the host can see all registered tools.

```json
{
  "type": "tool_registry_snapshot",
  "session_id": "abc123",
  "tools": []
}
```

### Tool registry delta

Sent by the app when a tool is added or removed after the session is active.

Upsert:

```json
{
  "type": "tool_registry_delta",
  "session_id": "abc123",
  "operation": "upsert",
  "tool": {
    "name": "sum"
  }
}
```

Remove:

```json
{
  "type": "tool_registry_delta",
  "session_id": "abc123",
  "operation": "remove",
  "name": "sum"
}
```

### Tool call

Sent by the host to the app when the operator uses `cordierite invoke`.

```json
{
  "type": "tool_call",
  "session_id": "abc123",
  "id": "call_1",
  "name": "sum",
  "args": {
    "a": 2,
    "b": 3
  }
}
```

### Tool result

Sent by the app when the tool succeeds.

```json
{
  "type": "tool_result",
  "session_id": "abc123",
  "id": "call_1",
  "result": {
    "total": 5
  }
}
```

### Tool error

Sent by the app when the tool fails.

```json
{
  "type": "tool_error",
  "session_id": "abc123",
  "id": "call_1",
  "error": {
    "type": "tool_execution_error",
    "message": "Something went wrong"
  }
}
```

Current tool error types include:

- `tool_not_found`
- `tool_input_validation_error`
- `tool_output_validation_error`
- `tool_execution_error`
- `tool_serialization_error`
- `tool_timeout`

## Local host control API

The CLI does not talk to the app socket directly after startup. Instead, `cordierite host` exposes a local HTTP control API on `127.0.0.1` and stores session metadata in the local session registry.

Current routes:

- `GET /session`
- `GET /tools`
- `POST /call`

The `session`, `tools`, and `invoke` CLI commands read the session registry, locate the correct local control port, and then call this local API.

### Current limitation

The local host control API is currently unauthenticated. Any process on the same operating system that can reach the local control port may inspect the session or invoke tools on the connected app.

This is a known limitation in the current implementation and should be considered part of the threat model.

## Failure handling

Important failure cases today:

- invalid bootstrap URL or payload: rejected before connect
- expired bootstrap payload: rejected before connect
- pin mismatch: TLS connection fails
- wrong or expired token: socket closed during claim
- second connection while one is active: rejected
- post-claim message with the wrong `session_id`: socket closed
- host TTL expiry before claim: pending session is discarded and host exits with error
- app disconnect after claim: host tears down runtime state and removes the session registry entry

## Operator flow

Typical operator flow today:

1. Run `cordierite keygen` and add the printed `sha256/...` value to app config.
2. Rebuild the app so native pin configuration is updated.
3. Start the host with `cordierite host --tls-key ... --scheme ...`.
4. Open the printed bootstrap deep link in the app, or use `--open` on the iOS simulator.
5. Use the returned `session_id` with:
   - `cordierite session --session-id <id>`
   - `cordierite tools --session-id <id>`
   - `cordierite invoke <name> --session-id <id> --input '{...}'`

## Notes

- The deep link is bootstrap data, not proof of authority.
- Pinned TLS is the host authentication mechanism.
- Cordierite currently supports one active claimed session per host runtime.
- Tool availability is dynamic and comes entirely from what the app registers in JavaScript.
