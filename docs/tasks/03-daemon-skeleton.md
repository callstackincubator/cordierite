# 03 — Daemon skeleton: state dir, config, lifecycle, UDS RPC, auto-spawn

## Goal

Stand up the long-lived daemon process and its control plane: state directory, config
loading, pidfile single-instancing, the newline-delimited JSON-RPC server on a unix
domain socket, `daemon.status`/`daemon.shutdown`, the `cordierite daemon
run|start|stop|status` subcommands, and the auto-spawning RPC client library every
other surface will use. No sessions or TLS yet.

## Depends on

02 (RPC types).

## Read first

- `docs/ARCHITECTURE.md` §3 (state dir), §4 (lifecycle), §5 (RPC framing/methods).
- `packages/cordierite/src/cli/create-cli.ts`, `dispatch.ts`, `runner.ts` — reuse the
  existing DI patterns (injected clock/writers) that make the CLI shell testable.
- `packages/cordierite/src/errors.ts` (exit-code mapping to keep).

## Scope

New modules under `packages/cordierite/src/`:

1. **`daemon/state-dir.ts`** — resolve the state dir (`CORDIERITE_STATE_DIR` override,
   default `~/.cordierite`), create with mode `0700`, path helpers for
   `daemon.sock`/`daemon.pid`/`daemon.log`/`key.pem`/`config.json`/`audit/`.
2. **`daemon/config.ts`** — load + validate `config.json` per §3 (defaults:
   `wssPort` 8443, `keyPath` `<state-dir>/key.pem`, `graceSeconds` 600,
   `linkTtlSeconds` 300, `keepaliveIntervalSeconds` 15, `policy.default` "allow",
   `policy.destructive` "allow"). Unknown keys → warning, not error. Invalid values →
   clear error naming the key.
3. **`daemon/pidfile.ts`** — acquire with `O_EXCL`; on conflict read the pid, check
   liveness with `process.kill(pid, 0)`, take over only if dead (unlink stale pidfile
   and stale `daemon.sock`). Release on shutdown.
4. **`daemon/rpc-server.ts`** — `net.createServer` on `daemon.sock` (unlink stale
   socket first; `chmod 0600` after listen). Framing: one JSON-RPC 2.0 message per
   line (`\n`-delimited). Dispatch table of method handlers; unknown method →
   JSON-RPC `-32601`; handler errors → JSON-RPC error with `data.type` from the shared
   error union. Per-connection write queue; cap line length at 1 MiB (drop connection
   beyond). Support server→client notifications (method `"event"`) targeted at
   connections that subscribed (subscription wiring lands in task 05 — here just
   expose a `notify(connection, payload)` primitive).
5. **`daemon/daemon.ts`** — composition root: state dir → config → pidfile → RPC
   server; implements `daemon.status` (version from package.json, pid, startedAt,
   configured `wssPort`, empty `sessions: []`, `pinnedKeys: []` until task 04) and
   `daemon.shutdown` (respond `{ok:true}`, then graceful teardown: close RPC server,
   release pidfile, unlink socket, exit 0). Handle SIGINT/SIGTERM identically.
6. **`rpc/client.ts`** — the client library (used by CLI, MCP, tests):
   `callDaemon(method, params, { stateDir, autoSpawn = true })`. Connect to
   `daemon.sock`; on `ENOENT`/`ECONNREFUSED` with `autoSpawn`: take an exclusive
   spawn-lock file (`daemon.spawn.lock`, `O_EXCL`, removed after), unlink stale
   socket if the pidfile is dead, spawn `daemon run` **detached** with stdio
   redirected to `daemon.log` (spawn `process.execPath` with the built `bin.js` +
   args — make the spawn command injectable for tests), poll the socket every 100 ms
   up to 5 s, then retry the request once. Also expose a persistent-connection
   variant for subscriptions (`openDaemonStream`).
7. **CLI wiring** — add `daemon run|start|stop|status` to the existing cac CLI
   (after task 01's demolition it only exposes `keygen`; the full v2 surface lands in
   task 06). `run` executes the composition root in the foreground. `start` uses the auto-spawn helper and reports
   the pid. `stop` calls `daemon.shutdown`, falls back to SIGTERM via pidfile.
   `status` renders `daemon.status` (respect the existing `--json` conventions).

## Out of scope

- TLS/wss listener, sessions, links, tools (tasks 04–05).
- Windows named pipes (leave a single `getSocketPath()` seam where it would plug in).
- Removing v1 commands.

## Implementation notes / gotchas

- The daemon must never crash on a bad RPC line: wrap `JSON.parse` per line, respond
  with `-32700`, keep the connection.
- Attach `error` listeners to every socket/server — the v1 host died from unhandled
  `'error'` events; do not repeat that.
- Auto-spawn double-start race: two CLI processes racing must result in exactly one
  daemon. The spawn-lock + pidfile `O_EXCL` combination covers it; the loser waits on
  the socket poll.
- Keep everything injectable (state dir, spawn fn, clock) — the tests below need it.

## Acceptance criteria

- `cordierite daemon run` (with `CORDIERITE_STATE_DIR` pointing at a temp dir) starts,
  creates the state dir `0700`, socket `0600`, answers `daemon.status`, exits cleanly
  on SIGTERM removing sock + pid.
- `cordierite daemon status` auto-spawns a daemon when none is running, then reports it.
- Second `daemon run` against the same state dir exits non-zero with a clear
  "already running (pid N)" error.
- `bun run lint/build/test` green from root.

## Testing

Integration-style tests with `bun test` in `packages/cordierite`, each using a fresh
temp `CORDIERITE_STATE_DIR`: status round-trip over the real UDS, malformed-line
handling, pidfile takeover after killing the process, auto-spawn (with injected spawn
fn), concurrent auto-spawn race (two clients, one daemon). Reuse the existing
fixture/DI style from `src/__tests__/`.

> Status: DONE. Implemented `daemon/{state-dir,config,pidfile,rpc-server,daemon}.ts`,
> `rpc/client.ts`, `commands/daemon.ts`, and CLI wiring (`daemon [action]` in cac, since
> cac only matches a command's first argv word — see comment in `create-cli.ts`). All
> acceptance criteria verified, including via a real spawned subprocess. Tests:
> `__tests__/{daemon,rpc-client,daemon-cli.integration}.test.ts` (20 new tests) plus an
> update to the existing CLI help-listing test. `bun run clean && build && test && lint`
> green from root. One out-of-scope defect noticed and left alone: `cli/runner.ts`'s
> `executeHostedCommand` still special-cases `command === "host"` for reporter gating —
> harmless here (this task supplies no reporter) but is v1 debris for task 06 to remove.
