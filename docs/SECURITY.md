# Security model

One page: what pinning defends against, what it doesn't, how to handle keys, and what
production deployments should turn on. See `docs/PROTOCOL.md` for wire-level detail and
`docs/ARCHITECTURE.md` §12 for the policy/audit implementation.

## Threat model

**What Cordierite defends against:**

- An attacker on the same Wi-Fi/LAN who can see or intercept traffic — the socket is
  `wss://` (TLS), not cleartext.
- An attacker who controls DNS, ARP, or IP routing on the network — the app authenticates
  the daemon by its certificate's SPKI hash (`sha256/...`), not by address or hostname.
  Being able to answer on the right IP is not enough to impersonate the daemon.
- An attacker who intercepts or replays a deep link — the link is bootstrap data for one
  short-lived, single-use session token, not a credential. A captured link is useless
  once its TTL elapses or its token is consumed, and 5 failed claim attempts against a
  session id burn the link outright.
- An unauthenticated local process on the same machine that isn't the operator — the
  control plane is a Unix domain socket under `~/.cordierite/` at mode `0600`, inside a
  `0700` directory; anything that can't read that socket can't talk to the daemon.

**What Cordierite does not defend against:**

- **A compromised operator machine.** Anything that can read `key.pem` or connect to
  `daemon.sock` has full control: it can mint links, list/invoke tools on any connected
  device, and read the audit log. The trust boundary is the operator's machine, full
  stop — see "Localhost/UDS trust boundary" below.
- **A malicious or compromised app build.** Cordierite constrains what an *external*
  caller can do to the app; it assumes the app's own code (and thus whatever tools it
  chooses to register) is trusted. A tool with `destructiveHint` still executes whatever
  its handler does — policy can deny the *call*, not audit the handler's internals.
- **Key compromise.** The pinned key doubles as both the trust anchor and the TLS
  identity (§ "Anchor-CA rotation" in `docs/ARCHITECTURE.md` §14 covers the deferred
  alternative). If `key.pem` leaks, an attacker with network access to a claimed or
  claimable session can impersonate the daemon until every app build with the old pin is
  retired. Rotation (below) is the mitigation, not prevention.
- **Anonymous internet exposure without policy.** Cordierite does not by itself decide
  whether exposing the `wss://` port to the internet is a good idea for your app; that
  decision is yours, and if you make it, policy + audit (below) are not optional.

## Key handling rules

- **Never commit a private key.** `git ls-files "*.pem"` must stay empty in this repo and
  should stay empty in yours. Test suites generate throwaway keys into temp directories
  at runtime; they are never checked in.
- **`key.pem` must be `0600`.** The daemon refuses to load a key file that is
  group- or world-readable — treat that refusal as the system working, not a bug to
  work around by loosening permissions.
- **One key per developer/environment**, not one key shared across a team or checked
  into a shared secrets store that many people can read. `cordierite keygen` is cheap;
  run it per machine.
- **Back up the fingerprint, not just the key.** The `sha256/...` value printed by
  `cordierite keygen` is what you actually ship in app config (`cliPins`); losing the key
  file just means generating a new one and re-shipping the app, which is the normal
  rotation path anyway.

## Rotation runbook

Both native clients accept a pin *set*, not a single pin — this is what makes rotation
possible without a flag day:

1. Generate a new key: `cordierite keygen --out new-key.pem`. Note its printed
   fingerprint (`sha256/NEW...`).
2. Add the new fingerprint to the app's `cliPins` **alongside** the existing one (don't
   remove the old one yet):
   ```json
   "cliPins": ["sha256/OLD...", "sha256/NEW..."]
   ```
3. Ship that app build. Any app on this build now trusts either key, so operators can
   run daemons on either the old or the new key without breaking anyone.
4. Point new/updated daemons at `new-key.pem` (`config.json`'s `keyPath`, or
   `cordierite keygen`'s default output).
5. Once every app build in the field has picked up step 2-3's release (track this the
   same way you track any minimum-supported-version rollout), ship a follow-up release
   that drops `sha256/OLD...` from `cliPins` and retires `key.pem`.

Treat this as the standard operating procedure, not an incident-response-only process —
rotating periodically, not just after a suspected compromise, keeps the runbook exercised
and keeps any one key's exposure window bounded.

## Production guidance

Cordierite is dev-first but production-capable: the same protocol runs everywhere,
production just turns on the pieces below rather than using a different architecture.

- **Policy.** Set `config.json`'s `policy.default` / `policy.destructive` (and per-tool
  `policy.tools["<alias>/<name>"]` overrides) to `"deny"` for anything you don't want an
  arbitrary caller invoking against a production build. Every `tools.call` — CLI and MCP
  alike — is evaluated against this before it ever reaches the app; a denial returns
  `policy_denied` and never sends a `tool_call` frame. Interactive consent prompting is
  not implemented (the policy configuration reserves a future `"prompt"` value);
  until then, `"deny"` is the only way to gate a tool that needs human sign-off.
- **Audit.** Every `tools.call` attempt — regardless of outcome — appends one line to
  `audit/<YYYY-MM-DD>.jsonl`: timestamp, session, alias, tool name, a sha256 of the
  canonicalized args (never the raw args), outcome, error type if any, duration, and
  caller (`cli`/`mcp`). This is on unconditionally; there's no flag to disable it. Check
  `daemon.status`'s `audit.failedWrites` if you need to confirm the log is actually
  landing on disk (e.g. under a read-only or full filesystem).
- **Compile out of release builds you don't want carrying Cordierite at all.** Import
  `@cordierite/react-native/noop` (or a Metro `resolveRequest` swap) instead of the real
  package — see the package README's "Compiling Cordierite out of production builds"
  section. This removes the native pinning code, the deep-link listener, and the tool
  registry entirely from that bundle, not just disables them at runtime.
- **App-store-review note.** An always-installed deep-link listener that can open a
  pinned socket and let an external process invoke code is a legitimate "remote control"
  surface from a reviewer's point of view, even though it can't be exercised without a
  trusted key. If you ship the real (non-`/noop`) entry in a build that goes to app-store
  review, be ready to explain the trust model in review notes; several teams find it
  simpler to ship `/noop` in review-track builds and the real entry only in
  internally-distributed or enterprise builds.

## The localhost/UDS trust boundary

The control plane (`daemon.sock`) is guarded by filesystem permissions, not by an
application-level credential: anything running as the same OS user that can open that
socket can do anything the CLI or MCP server can do — list sessions, invoke tools,
read audit-adjacent metadata, shut the daemon down. This is an intentional simplification
(matching the trust most local dev tooling — Docker's socket, most language-server
protocols — already assumes for the same-user case), not an oversight, but it means:

- Don't run the daemon as a different, more-privileged user than the processes that
  should be allowed to talk to it.
- Multi-tenant machines (shared CI runners, shared dev boxes) should give each
  tenant/user their own `CORDIERITE_STATE_DIR`, since anyone who can reach another user's
  socket has that user's full Cordierite access.
- This boundary is orthogonal to the `wss://` pinning boundary: compromising the UDS
  control plane gets you the same access as running the CLI yourself, but does not by
  itself hand you the private key or let you impersonate the daemon to a device that
  hasn't connected yet.
