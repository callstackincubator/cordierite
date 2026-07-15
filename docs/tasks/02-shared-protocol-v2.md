# 02 — @cordierite/shared: protocol v2 replaces v1

## Goal

Rewrite `@cordierite/shared` as **v2-only**: wire messages, bootstrap codec, tool
descriptors with annotations, the canonical error-type union, and the daemon RPC
types. v1 modules are deleted in this task, not kept alongside — public names are the
final ones (no `v2` prefixes or namespaces). The React Native package is the only
remaining v1 consumer after task 01; migrate its imports mechanically in the same
commit so the workspace stays green.

## Depends on

01.

## Read first

- `docs/ARCHITECTURE.md` §5 (error codes, RPC methods), §6, §7 (wire messages), §8
  (bootstrap v2) — these sections are the spec; implement them exactly.
- Current `packages/shared/src/` (`domains/messages.ts`, `bootstrap.ts`, `cli.ts`,
  `session.ts`, `transport.ts`, `standard-schema.ts`) — style reference and deletion
  target. Keep `standard-schema.ts` (unchanged) and the `ToolDescriptor`
  schema-carrying concept from `cli.ts`.
- RN consumers to migrate: `packages/react-native/src/deep-link-core.ts`,
  `bootstrap.ts`, `client-types.ts`, `registry-sync.ts`, `tool-invocation.ts`,
  `connect-helpers.ts` and their tests.

## Scope

### Shared package (the real work)

1. **Wire messages** (§7): TypeScript types + strict runtime type guards for every
   message (`session_claim`, `session_resume`, `session_ack`,
   `tool_registry_snapshot`, `tool_registry_delta`, `tool_call`, `tool_result`,
   `tool_error`, `tool_call_progress`, `event`). Guards must validate every field
   (types, string length limits, `protocol_version === 2`), reject unknown `type`
   values, and never allow `undefined`-indexing (the v1 snapshot guard only checked
   `Array.isArray(tools)` — a `[null]` element crashed the host; do not repeat this).
2. **ToolDescriptor** (§7): type + guard enforcing the name pattern
   `[a-zA-Z0-9_-]{1,64}`, required `description`, optional draft-2020-12 schemas
   (accept any JSON object; do not validate schema internals), optional `annotations`
   with only the three boolean hints.
3. **Error types** (§5): a single exported union of all error type strings and an
   `isKnownErrorType` guard — the one source of truth used by daemon, CLI, MCP, and
   RN packages.
4. **Bootstrap v2 codec** (§8): `encodeBootstrap(payload)` / `decodeBootstrap(b64url)`
   with the exact binary layout (version `0x02`, family byte, 4/16-byte address,
   2-byte port, len-prefixed sessionId, 32-byte token, 8-byte expiresAt seconds).
   base64url without padding. Decoder must reject: wrong version (including v1's
   `0x01` — no fallback), bad family byte, truncated/oversized buffers (strict
   total-length check), non-UTF-8 session ids, port 0. Address parsed to/from string
   form (`"192.168.1.10"` / `"fd00::1"`).
5. **Endpoint URL helper**: `formatAgentWebSocketUrl({ family, address, port })`
   bracketing IPv6 (`wss://[fd00::1]:8443`).
6. **RPC contract** (§5): types only — method name constants, param/result types for
   every method, `SessionSummary`, the session state union, event notification
   payloads with the `kind` union, JSON-RPC error `data.type` mapped to the error
   union.
7. **Delete** all v1 modules and exports that the above replaces; `index.ts` exports
   the v2 surface only.

### React Native package (mechanical migration only)

8. Update imports and payload handling so the package compiles and its unit tests
   pass against v2 shared: deep-link parsing uses the v2 codec (v2 test payloads in
   `__tests__`), message construction uses v2 types (`protocol_version: 2` where the
   JS layer builds frames), `ToolDescriptor` field names per §7. **Do not** implement
   resume/reconnect, new listeners, or any behavioral change — that is task 11. If a
   v1 behavior has no v2 equivalent yet (e.g. native still sends a v1-shaped claim
   internally), keep the JS boundary compiling and note it in the commit body;
   tasks 09–11 own the behavior.

## Out of scope

- Daemon, CLI, MCP (tasks 03+). RN behavioral changes (task 11). Native code (09/10).

## Constraints

- `@cordierite/shared` keeps **zero runtime dependencies** and stays portable: no
  Node-only APIs (`Buffer` etc.) — use `Uint8Array`/`DataView`, matching the v1
  codec's approach.

## Acceptance criteria

- `git grep "0x01" packages/shared packages/react-native/src` → no bootstrap-version
  hits; no v1 message names remain exported from shared.
- Every v2 message guard has tests: valid message, wrong `type`, missing field, wrong
  field type, oversized string fields, `[null]` tools element, unknown extra `type`.
- Bootstrap codec round-trips IPv4 and IPv6 byte-for-byte; each rejection case tested
  (wrong version incl. `0x01`, truncation, trailing bytes, bad family, non-UTF-8
  session id).
- `formatAgentWebSocketUrl` tested for IPv4 and IPv6; no `Buffer` usage (grep).
- `bun run lint/build/test` green from root — including the migrated RN package.

## Testing

Create `packages/shared/src/__tests__/` with a `"test": "bun test"` script (the
package has none today; add the turbo `test` entry if missing). Table-driven tests
are fine. RN tests: update payload fixtures to v2, keep assertions equivalent.

> Status: DONE. See commit `task(02): ...` on branch `grand-refactor`. The `cordierite`
> package (daemon/CLI, task 03+ scope) still imported v1 CLI-output types
> (`CliResult`/`CliError`/etc.) and dead bootstrap-parsing code from `@cordierite/shared`;
> those types moved to a local `packages/cordierite/src/cli/result-types.ts` (unused by
> the wire protocol, so out of `shared`'s v2 surface) and the dead `parse.ts` was
> deleted, purely to keep the root build green — no CLI behavior changed.
