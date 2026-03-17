# Mobile Agent ↔ App Handshake Protocol

## Overview

This document describes the recommended way for a React Native app to establish a secure connection to an authorized local agent without pairing and without any app-side confirmation UI.

The agent initiates the flow by opening the app via deep link. The app then connects back to the agent over a pinned TLS WebSocket connection.

This replaces the earlier idea of using plain `ws://` plus custom signed messages. The pinned `wss://` channel is simpler and provides real transport confidentiality and integrity.

---

## Goals

- No pairing flow in the initial version
- Agent starts the connection
- No app-side confirmation UI
- Safe on hostile local Wi-Fi
- One active session per device
- Suitable for production use when the trust material is provisioned correctly

---

## Non-Goals

- User-mediated trust establishment
- Support for multiple trusted agent identities
- Long-lived background sessions
- Fine-grained tool permissions

---

## Security Model

The app trusts exactly one agent identity in the initial version.

That trust is established by embedding a pinned TLS identity in the app:

- either the agent server certificate
- or, preferably, the certificate's public key / SPKI pin

The agent holds the corresponding private key and terminates a local `wss://` server.

The app does not trust:

- the local IP address
- the local network
- the deep link payload by itself

The deep link is only bootstrap data. Authentication is provided by TLS pinning, and session authorization is provided by short-lived one-time session data.

---

## Why Not Plain `ws://` With Signed Messages

Using `ws://` with signatures is not enough for this use case:

- A local attacker can still proxy traffic between app and agent.
- A passive observer can read all traffic.
- A session key derived from exchanged nonces is not secret if those nonces were sent in clear.
- The protocol becomes custom cryptography and is easier to get wrong.

For this reason, the transport must be `wss://` with pinning.

---

## Transport

- Protocol: WebSocket over TLS
- Endpoint: `wss://<local-ip>:<port>`
- Direction: App connects to agent

---

## High-Level Flow

```text
Agent starts local WSS server
Agent creates pending session with one-time token
Agent opens app using deep link
App validates deep link shape and freshness
App connects to agent via WSS
App verifies pinned TLS identity
App sends session_id + token
Agent validates and consumes token
Session established
```

---

## Trust Material

### App

The app embeds the trusted agent TLS identity.

Example:

```ts
const trustedAgentPin = "sha256/base64-spki-pin";
```

The app must reject the connection if the presented certificate or public key does not match the pinned identity.

### Agent

The agent holds the TLS private key and certificate used by the local `wss://` server.

Example:

```ts
const tlsKeyPath = "/path/to/agent-key.pem";
const tlsCertPath = "/path/to/agent-cert.pem";
```

---

## Session Model

Only one pending or active session is allowed per device.

Before opening the deep link, the agent creates a pending session record:

```json
{
  "session_id": "abc123",
  "token": "base64url-random-32-bytes",
  "ip": "192.168.1.42",
  "port": 8443,
  "expires_at": 1710000030,
  "status": "pending"
}
```

Requirements:

- `token` must be generated with a cryptographically secure RNG
- token length should be at least 128 bits, preferably 256 bits
- token must be single-use
- token must expire quickly, for example after 30 seconds
- after first successful use, mark it as consumed
- the agent should reject new pending sessions while one already exists

---

## Step 1: Deep Link Bootstrap

### Format

```text
myapp:///?cordierite=BASE64URL(WIRE)
```

### Payload

`WIRE` is base64url without padding. The **default agent encoding** is **binary v1** (shortest QR-friendly form):

- `0x01` version
- 4-byte IPv4 (big-endian `uint32`, dotted-quad semantics)
- 2-byte port (big-endian `uint16`)
- 1-byte `sessionId` UTF-8 length, then `sessionId` bytes (1–255)
- 32 raw token bytes (same octets as the base64url token decodes to)
- 4-byte `expiresAt` Unix seconds (big-endian `uint32`)

The `cordierite` query value must decode to **binary v1** only (no JSON object or array wire forms).

### App Validation Rules

The app should do lightweight validation before attempting the connection:

- reject if `expiresAt` is in the past
- reject if the payload is missing required fields
- reject invalid port values
- optionally reject non-private IP addresses

Important:

- the deep link is not an authentication mechanism
- possession of the token does not replace TLS pinning
- the token only authorizes one short-lived pending session

---

## Step 2: App Connects to Agent

The app opens a pinned TLS WebSocket connection:

```ts
const ws = new WebSocket(`wss://${ip}:${port}`);
```

During the TLS handshake, the app must verify that the server identity matches the embedded pin.

If pin verification fails:

- close the connection
- reject the session

---

## Step 3: App Claims the Pending Session

Once the pinned `wss://` connection is established, the app sends a session claim message:

```json
{
  "type": "session_claim",
  "session_id": "abc123",
  "token": "base64url-random-32-bytes"
}
```

The app may include optional device metadata (for agent UX / logging). Each value must be a string no longer than 256 characters:

- `device_manufacturer` (e.g. `Apple`, `Google`)
- `device_model` (e.g. hardware identifier or commercial model name)
- `device_os` (e.g. `iOS 18.2`, `Android 14`)

Example with device fields:

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

The agent validates:

- `session_id` exists
- optional `device_manufacturer`, `device_model`, and `device_os`, if present, are strings of at most 256 characters (otherwise the claim is rejected)
- token matches the pending session
- token has not expired
- token has not already been consumed
- no other connection has already claimed the session

If validation succeeds:

- mark the token as consumed
- mark the session as active

If validation fails:

- close the connection immediately

---

## Step 4: Session Acknowledgement

On success, the agent responds:

```json
{
  "type": "session_ack",
  "session_id": "abc123",
  "status": "ok"
}
```

At this point, the session is established and all further traffic continues over the same pinned TLS channel.

---

## Message Security After Handshake

No extra message-level signatures are required for the initial implementation.

Rely on the established `wss://` channel for:

- confidentiality
- integrity
- server authentication

Each application message should still be bound to the current session:

```json
{
  "type": "tool_call",
  "session_id": "abc123",
  "id": "call_1",
  "name": "open_screen",
  "args": {
    "screen": "Profile"
  }
}
```

The receiver should reject messages whose `session_id` does not match the active session.

---

## Failure Handling

| Condition | Action |
|----------|--------|
| TLS pin mismatch | Close connection |
| Unknown session | Close connection |
| Invalid token | Close connection |
| Expired token | Close connection |
| Reused token | Close connection |
| Session already claimed | Close connection |
| Session mismatch in later messages | Close connection |

---

## Why Keep Session Authorization If We Already Pin TLS

TLS pinning proves the app is talking to the real trusted agent endpoint.

The session token solves a different problem: authorizing one specific bootstrap attempt.

It gives us:

- binding between the deep link and the accepted connection
- replay resistance for stale deep links
- a clean way to expire or cancel a launch attempt
- protection against anything that can trigger the app's custom URL scheme

Even with only one session allowed per device, the token is still useful and cheap to implement.

---

## Operational Requirements

- The agent should listen only while waiting for the app or while a session is active
- Pending sessions should expire quickly
- Active sessions should have a maximum lifetime
- Closing the active session should also tear down any leftover pending state
- Agent logs should never print the raw token

---

## Notes

- Do not trust local network origin as identity
- Do not treat the deep link payload as authenticated
- Do not use `ws://` for this protocol
- Do not derive a session key from public nonces
- Treat the LAN as hostile

---

## Future Improvements

- Support multiple trusted CLI identities and rotation
- Move from a single pinned identity to a managed trust store
- Add app authentication if we later need stronger client identity
- Add per-tool authorization or policy controls
- Add explicit user approval for sensitive actions
