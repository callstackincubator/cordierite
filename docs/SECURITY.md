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

## Trust modes

What a build trusts is decided by an explicit `trust` config value — `"pin"` or `"link"` —
never by whether the build happens to be debuggable. There is no build-type signal anywhere
in this resolution on either platform.

**`trust: "pin"`** is everything described above: the app embeds a key fingerprint set
(`cliPins`) ahead of time and refuses anything else. Requires non-empty `cliPins`; the config
plugin rejects `trust: "pin"` with empty/missing `cliPins` at prebuild time, and the native
trust-resolution logic (`resolveTrustedPins` on both platforms) rejects the same combination
again if that check is ever bypassed by hand-editing native config.

**`trust: "link"`** — the default whenever `cliPins` is absent, and available in **any**
build type, not just a locally-run debug build — is a deliberately weaker flow so that a
fresh clone of this repo (or a fresh app project) works with zero setup:

- The daemon auto-generates `key.pem` the first time it starts if the file is missing, and
  prints its `sha256/...` fingerprint.
- `cordierite link` composes that fingerprint into the deep link as a separate `pin` query
  param, alongside the existing binary `cordierite` bootstrap payload. The binary payload
  format is unchanged — an app build that doesn't know about `pin` simply ignores it.
- The native client trusts that link-carried pin, for that one link's session only, when the
  effective trust mode is `"link"` (explicit, or the default because no `cliPins` are
  configured) and the connect options actually carry a `linkPin`. It then logs,
  unconditionally (not gated behind any log level):

  ```
  Cordierite: trust=link — trusting the SPKI pin carried by the bootstrap link for this session.
  ```

- The moment `cliPins` is configured, that embedded set always wins regardless of `trust`'s
  value, and the link's `pin` is ignored outright — config can only *narrow* trust, never
  widen it back to link TOFU.
- **A `trust` value that is neither `"link"` nor `"pin"`** — a typo like `"PIN"` or a
  hand-edited native config — is a hard error, both at config/prebuild time and independently
  in the native trust-resolution logic, deliberately: it must never be treated as the
  missing-key default, which would let a mistyped `trust` silently widen an intended `"pin"`
  configuration into permissive link TOFU.

**What changed vs. pinned trust:** the trust anchor moves from "a key you baked into the
binary ahead of time" to "whoever handed you this link" — the same class of trust a
`ssh <host>` on first connect or an unauthenticated `npm install <package>` extends to
whoever controls that name at the moment you run it. It is intentionally weaker, which is
why production and internal-distribution deployments should configure `cliPins` (which flips
the effective trust mode to `"pin"` automatically) rather than relying on the default.

**Residual risk:** an attacker already on the operator's private LAN who can get someone to
open a malicious bootstrap link or scan a malicious QR code on a build with no embedded pins
can stand in for a legitimate daemon for that one session — the same link-replay and
short-lived-token protections in the main threat model still apply (a captured link is
useless once its TTL elapses or its token is consumed), but there is no embedded key to
check the link's claimed identity against. This is a materially smaller blast radius than no
pinning at all (still requires LAN presence, still requires a social-engineering step, still
bounded by the link's TTL), but it is not equivalent to pinned trust — do not leave a
production or internal-distribution build without `cliPins` for anything beyond local
development.

**What actually contains link trust now, since there is no build-type gate:** it is opt-in
configuration alone. Set `cliPins` (which makes `trust: "pin"` the default) on any build you
don't want accepting a link-carried pin. Separately, if you don't want Cordierite's native
code present in a build at all — regardless of trust mode — exclude it from autolinking (see
"Compile out of a build you don't want carrying Cordierite at all" below); `cordierite doctor` (`docs/CI.md`) verifies that
exclusion actually took effect in a built artifact, rather than trusting the config that was
supposed to produce it.

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

**Policy and audit are operator ergonomics, not a production control.** Both run on the
daemon, which lives on the operator's machine — the trust boundary this document already
names above ("A compromised operator machine"). Anyone who can read `key.pem` or reach
`daemon.sock` controls the daemon directly and is not subject to its own policy config or
audited by its own audit log; policy/audit shape what a *legitimate* CLI/MCP caller talking
to an *honest* daemon can do, they do not defend the app against the operator machine
itself. The control that actually sits inside the app, on the app's side of the trust
boundary, is **which tools the app registers at all** — `useCordieriteTool`'s `enabled`
option (see the package README's "Gating a tool by build variant") lets an app conditionally
withhold a destructive tool's registration based on its own release-pipeline-controlled
build flag, independent of whatever the operator machine's daemon policy says. Treat policy
and audit below as convenience for a trusted operator working across many tools/sessions,
not as the mechanism that keeps a destructive tool out of reach of a hostile one.

- **Policy.** Set `config.json`'s `policy.default` / `policy.destructive` (and per-tool
  `policy.tools["<alias>/<name>"]` overrides) to `"deny"` for anything you don't want an
  arbitrary caller invoking against a production build. Every `tools.call` — CLI, MCP, and
  `cordierite/client` alike — is evaluated against this before it ever reaches the app;
  a denial returns `policy_denied` and never sends a `tool_call` frame. `"prompt"` requires a human gate
  and fails closed everywhere one can't be guaranteed: today the only implemented gate
  is an MCP client that enforces `_meta["anthropic/requiresUserInteraction"]` (Claude
  Code ≥ v2.1.199); the CLI and every other client are denied outright
  (`policy_denied`, reason `no_consent_channel`) rather than silently treated as
  `"allow"`. That gate is *not* a defense within this feature's own trust boundary: the
  daemon trusts the MCP server's `consent: "client"` param verbatim rather than
  re-deriving it, so any local process that can reach `daemon.sock` — including the CLI,
  or an agent with shell access, which is the typical Claude Code setup this feature
  targets — could send that param directly, the same way it could send any other RPC
  call. This is consistent with, not an exception to, the trust boundary above: anything
  that can reach the socket already has full daemon control. `"prompt"` guards against a
  compliant MCP client silently auto-approving on the caller's behalf, not against a
  hostile process on the operator's own machine. `clientInfo` is also self-reported, so
  it's not a defense against a hostile client claiming to be a compliant one either —
  only against a compliant client's own auto-approval. Two behaviors worth knowing about
  rather than filing as bugs: non-interactive Claude Code (`--permission-prompt-tool`)
  converts an `allow` result for a flagged tool into a denial — that conversion is the
  client's, not the daemon's; and `"prompt"` denies unconditionally in CI or any other
  unattended pipeline (there is no consent channel there at all), so a pipeline that
  needs a tool to run unattended must set `allow`/`deny` for it explicitly. Until a
  non-MCP consent channel ships (see the project's issue tracker), `"deny"` remains the
  only way to hard-block a tool for CLI callers.
- **Audit.** Every `tools.call` attempt — regardless of outcome — appends one line to
  `audit/<YYYY-MM-DD>.jsonl`: timestamp, session, alias, tool name, a sha256 of the
  canonicalized args (never the raw args), outcome, error type if any, duration, caller
  (`cli`/`mcp`/`client`), and — only for a `"prompt"` call that proceeded — `consent: "client"`.
  That marker is the weakest form of evidence recorded here: the daemon never observes
  the actual consent decision, only that the call arrived already gated, so it's kept
  distinct from a plain `"ok"` rather than folded into it. This is on unconditionally;
  there's no flag to disable it. Check `daemon.status`'s `audit.failedWrites` if you
  need to confirm the log is actually landing on disk (e.g. under a read-only or full
  filesystem).
- **Inclusion defaults to dev builds only — not a compiled-in build-type check.** On iOS,
  `react-native.config.js` sets CocoaPods' `:configurations` so the `Debug` configuration
  links Cordierite and `Release` doesn't, by default: a real per-variant linking decision.
  Android can't use the equivalent `buildTypes` lever for a package with static Java
  registration (`packageInstance`) — the Gradle plugin's generated `PackageList.java` is
  shared, unfiltered, across every variant, so restricting *linking* by variant there is a
  compile error, not an inert build. Android instead links this project into every variant
  unconditionally and swaps which Kotlin source set `android/build.gradle` compiles for
  `release`: the real implementation by default for `debug`, and either the same real files
  or a no-op `CordieritePackage` for `release`, driven by the same `CORDIERITE_ENABLED`.
  Either way there is still no `debuggable`/`#if DEBUG` gate anywhere in
  `CordieritePackage.getModule` (Android) or `CordieriteTurboBridge.swift`/
  `RCTNativeCordierite.mm` (iOS) — both register/compile in unconditionally whenever the real
  implementation is linked/compiled into a given variant; whether it is is what the
  CocoaPods/Gradle config above decides. A release pipeline that wants Cordierite anyway (an
  agent-driven, release-signed internal build, for example) sets `CORDIERITE_ENABLED=1`; one
  that wants it gone even from debug sets `CORDIERITE_ENABLED=0`. Either way this is something
  you can verify against the built artifact (`cordierite doctor`, `docs/CI.md`) — on Android,
  `doctor` deliberately trusts only its `CordieriteNativeMarker` keep-rule signal for this
  reason, since the release-default no-op stub shares the real implementation's package name
  and would otherwise look present to a naive scan. Not something that quietly depends on a
  custom build-type/configuration name being spelled `debug`/`Debug`. When the module
  genuinely isn't present (excluded, or no native support at all — e.g. Expo Go), the JS
  public API degrades to the exact `./noop` entry's behavior (one warning, no throws) — see
  `docs/ARCHITECTURE.md` §11.
- **Compile out of a build you don't want carrying Cordierite at all.** Being present and
  trusting nothing (`trust: "pin"` with a `cliPins` set that has no matching daemon, or an
  app that simply never mints a bootstrap link for that build) still ships the native code
  and JS bundle inside the binary. To strip it out entirely, combine two independent
  steps — neither one alone removes native code:
  1. **Native:** exclude `@cordierite/react-native` from autolinking. This is what
     actually removes the compiled native pod/module from the app binary. Bare RN:
     app-root `react-native.config.js`, `dependencies["@cordierite/react-native"].platforms
     = { ios: null, android: null }`. Expo-managed equivalent: `expo.autolinking.ios.exclude`
     / `expo.autolinking.android.exclude` — but this must live in **`package.json`**, not
     `app.json` or `app.config.*`. `expo-modules-autolinking` reads this config from
     `package.json` only; the same block anywhere else is a silent no-op that still ships
     the native module. Note also that `expo-modules-autolinking`'s CocoaPods driver
     resolves iOS with `--platform apple`, and an `expo.autolinking.apple` block, if
     present, wins outright over `expo.autolinking.ios` rather than merging with it — put
     the exclude under `apple` too if your app declares that key. Excluding on iOS also
     stops that package's codegen from running, so an app that excludes it there but still
     references the `Cordierite` pod by hand (a maintainer-only shape, e.g. attaching an
     XCTest target) will fail to compile.
  2. **JS:** swap the module at bundle time with a Metro `resolveRequest` override that
     resolves `@cordierite/react-native` (and `/auto`) to `@cordierite/react-native/noop`
     instead. This removes the deep-link listener and tool registry from the JS bundle.

  See the package README's "Compiling Cordierite out of production builds" section for
  the exact snippets, and `docs/CI.md` for `cordierite doctor`, which verifies the
  exclusion actually took effect in a built artifact rather than trusting the config that
  was supposed to produce it — this whole area was a config recipe that never worked once
  before (see `docs/tasks/02-fix-autolinking-exclusion.md`), which is why it's now checked
  by CI, not just documented. Either half alone still yields a working, inert-with-respect-
  to-that-half app — the autolinking exclude alone leaves the real JS entry importable but
  with no native module to find (so it degrades to `/noop`-equivalent behavior); the Metro
  swap alone leaves the native pod compiled in but unused. Combine both when you want
  neither surface present at all.
- **App-store-review note.** An always-installed deep-link listener that can open a
  pinned socket and let an external process invoke code is a legitimate "remote control"
  surface from a reviewer's point of view, even though it can't be exercised without a
  trusted key. A release build submitted to app-store review does *not* carry Cordierite by
  default (see above); a team that overrides this with `CORDIERITE_ENABLED=1` for a review
  build should be ready to explain the trust model in review notes, or exclude Cordierite
  entirely (above) for that build track instead.

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
