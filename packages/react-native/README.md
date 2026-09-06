[![Cordierite][cordierite-banner]][repo]

### Tools and state from outside the app—without debug menus

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

This package is the **native client** for Cordierite. Your app **registers tools** in JavaScript; **developers, testers, and agents** invoke them from a **CLI or host** after the app opens a bootstrap link and completes a **pinned `wss://`** handshake. You get **production-grade transport** (TLS + SPKI) instead of burying **debug-only screens** in the UI to flip state or trigger flows.

## Why use it

- **No in-app debug chrome**: influence screens, flags, fixtures, and flows from the **host**, not from hidden menus shipped to users.
- **Same path for people and automation**: CLI for devs/QA, agents for scripted or LLM-driven control—both use **tool calls** after session claim.
- **Production-capable**: ship the client in real builds when your pins and operational model say it is acceptable; connectivity still requires a **trusted host**, not public anonymous access.

## Security highlights

- **TLS required** for the Cordierite socket; pins are **SHA-256 over SPKI** (`sha256/...`) so only **your** host keys match.
- **Optional `allowPrivateLanOnly`**: when enabled, bootstrap must target a **local IPv4** address (RFC1918 private ranges or `127.0.0.1`)—a **dev-hardening** switch, not a claim that Cordierite is LAN-only.

## Getting started

> [!NOTE]
> Use a **development build** or bare native app. **Expo Go** is not enough—this library ships native code and pinning configuration.

### 1. Install the package

Install the app-side package and a schema library for tool definitions:

```bash
npm install @cordierite/react-native zod
```

Install the CLI separately on the machine that will run the host:

```bash
npm install cordierite
```

### 2. With no pins configured, that's it for keys and pins

**No key, no pins, and no config plugin needed at all — in any build type.** The daemon auto-generates its own `key.pem` the first time it starts (printing its `sha256/...` fingerprint), and `cordierite link` composes that fingerprint into the deep link as a separate `pin` query param. Whenever no build-time `cliPins`/`CLI_PINS` are configured, the effective `trust` mode is `"link"` by default: the native client trusts that link-carried pin for the session it arrived with, logging unconditionally: `Cordierite: trust=link — trusting the SPKI pin carried by the bootstrap link for this session.` This is no longer tied to whether the build is debuggable — only to whether pins are configured. The moment `cliPins` is configured, that embedded set always wins regardless of `trust`, and the link's `pin` is ignored — see [`docs/SECURITY.md`](../../docs/SECURITY.md)'s "Trust modes" section for the full writeup.

Skip straight to step 3 (scheme) and step 4 (import) if that's all you need. The rest of this section is for **production and internal-distribution builds that want pinned trust** — debug builds ship Cordierite by default regardless, so this is about tightening what it trusts once it's there (and, separately, about controlling *whether* it ships at all in a given build variant — see "Compiling Cordierite out of production builds" below).

### 3. Configure native pinning and app scheme

#### Expo

Add the **`@cordierite/react-native`** config plugin to Expo config. `cliPins` is optional (omit it and the link-trust flow above applies), but required — non-empty, each a `sha256/` + 44-character base64 SPKI pin, or the plugin throws naming the offending value — whenever `trust: "pin"` is set (or implied by `cliPins` being non-empty). Also optional: `trust` (`"link"` | `"pin"`, defaulted as above — any other value is a config-time error), `allowPrivateLanOnly` (defaults to `true`, fail-closed), and `deepLinkScheme` (warns at prebuild time if it isn't declared in `expo.scheme`):

```json
{
  "expo": {
    "scheme": "myapp",
    "plugins": [
      [
        "@cordierite/react-native",
        {
          "cliPins": ["sha256/REPLACE_WITH_KEYGEN_OUTPUT"],
          "trust": "pin",
          "allowPrivateLanOnly": true,
          "deepLinkScheme": "myapp"
        }
      ]
    ]
  }
}
```

Generate the pin with `cordierite keygen`, which prints the exact `sha256/...` fingerprint value to use. Then run your normal prebuild / rebuild flow so native config receives those values.

Leave `cliPins`/`trust` unset entirely if you're fine with link-per-session trust — it's the default, and a plain zero-config setup can skip this whole plugin entry.

#### Bare React Native

Autolink the module and set the equivalent native keys. Field names and semantics mirror the Expo plugin (see [app.plugin.js](app.plugin.js)).

**Bare React Native — native keys**

iOS `Info.plist`:

| Key | Purpose |
| --- | ------- |
| `CordieriteCliPins` | String array of `sha256/...` SPKI pins |
| `CordieriteTrust` | `"link"` \| `"pin"` — any other value is a hard error at connect time |
| `CordieriteAllowPrivateLanOnly` | Boolean; if true, bootstrap host must be a local IPv4 address |

Android `<application>` meta-data:

| Name | Purpose |
| --- | ------- |
| `com.callstackincubator.cordierite.CLI_PINS` | JSON array string of pin values |
| `com.callstackincubator.cordierite.TRUST` | `"link"` \| `"pin"` — any other value is a hard error at connect time |
| `com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY` | Boolean meta-data value (a `"true"`/`"false"` String is also accepted); defaults to `true` (fail-closed) when absent |

None of the above is required for a zero-config app — see step 2. Wire **deep links** so the OS can open your app with the host's bootstrap URL, and make sure the app scheme matches the one `cordierite link` uses to compose that link.

For an Expo app that is automatic: `cordierite link` reads `expo.scheme` straight out of `app.json`, so declaring the scheme once for deep links is all it takes. Otherwise (a dynamic `app.config.js`, which Cordierite never executes, or bare React Native) name it with `cordierite init --scheme <s>`, `--scheme`, or `CORDIERITE_SCHEME` — see the [`cordierite` package README](../cordierite/README.md#the-deep-link-scheme) for the full resolution order.

### 4. Import Cordierite in the JS entry point

The package has three entries:

| Entry | Behavior |
| --- | --- |
| `@cordierite/react-native` | Side-effect-free. Exports `registerTool`, `useCordieriteTool`, `postEvent`, `addCordieriteListener`, `getCordieriteState`, `restoreSession`, `connect`, and types. The native module is looked up **lazily**, on the first actual native call — importing it (even in Expo Go or a misconfigured build) never crashes; only calling a native-requiring function like `connect()` without native support does, with an actionable error. |
| `@cordierite/react-native/auto` | Same exports, plus a side effect: installs the deep-link bootstrap listener and starts recovery from the native process lease on import. This is the only entry that installs anything. |
| `@cordierite/react-native/noop` | Same public API, fully inert — for compiling Cordierite out of release builds (see below). |

Most apps just want the deep-link listener installed automatically, so import the side-effect entry once near your app's entry point:

```ts
import "@cordierite/react-native/auto";
```

To control *when* that happens — only in `__DEV__`, behind a QA-build toggle, or after other startup work — `require()` the same entry at that point instead. Metro resolves it lazily, and importing it more than once installs once:

```ts
if (__DEV__) {
  require("@cordierite/react-native/auto");
}
```

There is nothing to configure here: which addresses a bootstrap link may point at is native build config (`allowPrivateLanOnly`, configured through the Expo plugin / `CordieriteAllowPrivateLanOnly` above), enforced by native `connect()` and read from the same place by the deep-link handler.

If you drive bootstrap entirely yourself (custom deep-link routing, QR scanning, tests) and never import `/auto`, call `restoreSession()` once at startup before your own bootstrap handling — it is then the only thing reading the native resume lease, and without it every Metro reload drops a session the native side could still have resumed:

```ts
import { connect, parseBootstrapUrl, restoreSession } from "@cordierite/react-native";

if (!(await restoreSession())) {
  await connect(parseBootstrapUrl(url)); // only claim a fresh link if there was nothing to restore
}
```

**Bootstrap connection and recovery:** installation registers the runtime URL listener immediately, reads the initial launch URL, and attempts native-lease recovery once. The initial URL waits for recovery: a successful restore suppresses the old launch-link claim, while no lease or an unexpected orchestration failure falls back to the normal initial-link flow. Runtime URLs still parse the v2 bootstrap payload and call `connect` when the client is idle. You do not need your own `Linking` handler for the default flow.

The resume lease is native **process-memory only** and is committed before JS receives each successful claim/resume acknowledgement. That supports Metro reloads and JS runtime replacement with the same alias and no new link, provided the native app process stays alive. It is never persisted to disk; after native process death, open a fresh bootstrap link. The grace window starts when the transport suspends/disconnects, not when the acknowledgement was received. Any flow can trigger the same recovery explicitly with the exported `restoreSession()` (or `cordieriteClient.restoreSession()`).

**Reconnect vs. give up:** socket loss inside the grace window auto-reconnects with jittered backoff (0.5 s → 30 s cap), including transport-level closes such as `1011 send_failed` and `1001 daemon_shutdown` — the daemon may well be back before grace expires. A `1008` close is different: it is how the daemon reports a rejection no retry of the same frame can satisfy (`unknown_session` after a daemon restart, `invalid_resume_token`, an expired or revoked session, a malformed frame). Those end the session immediately with a `sessionChange: lost` carrying the daemon's reason, instead of retrying for the rest of the grace window.

**Errors:** use `addCordieriteListener("error", callback)` for bootstrap-parse, connect, socket, and tool-handler failures — one unified channel.

### 5. Define tools in app startup code

Call `registerTool({ ... })` with `inputSchema`/`outputSchema` plus a `handler` so the host can invoke your tools after the session is active.

#### Accepted schema forms

An agent can only use a tool it can see the shape of, so every form below except the last one publishes a real JSON Schema:

| `inputSchema` / `outputSchema` | Validated app-side with | Published to agents | `handler` argument type |
| --- | --- | --- | --- |
| Standard Schema **with** a JSON Schema exporter — zod 4, arktype | `~standard.validate` | its `~standard.jsonSchema` export | the schema's own type |
| `{ schema, jsonSchema }` pair — zod 3, valibot, anything else | `schema["~standard"].validate` | the `jsonSchema` you supply (an object, or an `{ input, output }` converter) | the schema's own type |
| A raw JSON Schema object (no `~standard` property) | **nothing** — args reach the handler as sent | the object, verbatim | `Record<string, unknown>`, or `T` via `jsonSchema<T>()` |
| Standard Schema **without** an exporter — bare zod 3, plain valibot | `~standard.validate` | **nothing** — throws in dev (see below) | the schema's own type |

A Standard Schema does not have to be a plain object: arktype's `Type` is callable, and is detected the same way (anything carrying `~standard.validate`).

Whatever form you use, an **input schema must be object-typed at its root** to be callable over MCP — a root `enum`, `const`, `$ref` or `anyOf` is legal JSON Schema but leaves the agent with no named arguments to pass (see [#34](https://github.com/callstackincubator/cordierite/issues/34)).

Cordierite has no third-party runtime dependencies and does not bundle a JSON Schema validator, so a raw JSON Schema describes the tool for the agent but never enforces anything. Use a pair when you want both a real shape *and* real validation.

The wire field is documented as draft 2020-12, but Cordierite forwards whatever you supply as-is — it does not normalize, re-target, or check the dialect, and different libraries emit different JSON Schema for the same shape (draft version, `additionalProperties`, how `default` is handled). Pick the target closest to 2020-12 that your converter offers.

**Zod 3** — pair the schema with `zod-to-json-schema`:

```ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const sumInput = z.object({ a: z.number(), b: z.number() });

registerTool({
  name: "sum",
  description: "Add two numeric values",
  // `zod-to-json-schema` has no 2020-12 target; 2019-09 is the closest it offers, and its
  // default (`jsonSchema7`) stamps a draft-07 `$schema`. Either is understood in practice.
  inputSchema: {
    schema: sumInput,
    jsonSchema: zodToJsonSchema(sumInput, { target: "jsonSchema2019-09" }),
  },
  handler: async ({ a, b }) => undefined, // `a` and `b` are still typed `number`
});
```

**Valibot** — the same shape, with `@valibot/to-json-schema`:

```ts
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";

const sumInput = v.object({ a: v.number(), b: v.number() });
const inputSchema = { schema: sumInput, jsonSchema: toJsonSchema(sumInput) };
```

**No validation library at all** — hand over JSON Schema directly. `jsonSchema<T>()` is an optional, purely type-level helper that tells the handler what to expect; it validates nothing:

```ts
import { jsonSchema, registerTool } from "@cordierite/react-native";

registerTool({
  name: "weather",
  description: "Current weather for a city",
  inputSchema: jsonSchema<{ city: string }>({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  }),
  handler: async ({ city }) => fetchWeather(city),
});
```

If your JSON Schema value is typed as an *interface* (`JSONSchema7` from `@types/json-schema`, for instance) TypeScript will not accept it directly: interfaces do not get the implicit index signature that `Record<string, unknown>` requires. Pass it through `jsonSchema<T>()`, or cast it.

**What is rejected.** A raw schema must be a *plain* object — an object literal or `Object.create(null)`, not a class instance — and its `type`, if it has one, must be a real JSON Schema type name (or an array of them). `{}` is fine: it is the canonical accept-anything schema. This rules out passing a validator from a library with no Standard Schema support (yup, joi, superstruct, valibot 0.x): those instances carry a `type` on their *prototype*, so a looser check would publish one as the tool's shape, and their internal circular references would then break serialization of the entire tool registry rather than just that tool.

An object mentioning `schema` or `jsonSchema` that is not a valid pair is rejected too — `{ schema: someJsonSchema, jsonSchema }` and a lone `{ jsonSchema }` are malformed pairs, and publishing them verbatim would make the wrapper itself the tool's advertised shape. The `jsonSchema` half of a pair, and anything a converter returns, must satisfy the same plain-object rule.

All of these throw a `TypeError` at registration naming what to fix.

**A Standard Schema with no exporter throws in development.** Passing a bare zod 3 or plain valibot schema used to register the tool with no shape at all, which agents saw as "takes any object" — the tool looked fine and was unusable. In `__DEV__` that now throws at `registerTool` with a message pointing at the two forms above — including when the call comes from `useCordieriteTool`, where the throw surfaces from the component's effect. Release builds keep the old behaviour (one console warning per tool name, tool registered without a schema) so an app already shipping such a tool is not broken by upgrading.

#### Registering from a component

`useCordieriteTool` wraps `registerTool` in a `useEffect` so registration follows the component's lifecycle, including remounts and Fast Refresh. It takes exactly the same schema forms; the example below uses zod 4, whose built-in exporter needs no pairing:

```ts
import "@cordierite/react-native/auto";
import { useCordieriteTool } from "@cordierite/react-native";
import { z } from "zod";

export function CordieriteBootstrap() {
  useCordieriteTool({
    name: "sum",
    description: "Add two numeric values",
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    outputSchema: z.object({
      total: z.number(),
    }),
    handler: async ({ a, b }) => ({
      total: a + b,
    }),
  });

  return null;
}
```

Mount that component near app startup, or register from another module that loads on startup. The host can only list and invoke tools that your app has already registered.

**Registration is per mount, not per render.** The hook registers once when the component mounts and re-registers only when something that changes the registration itself changed: `name`, `description`, the exported input/output JSON Schemas, `annotations`, `timeoutMs`, or `enabled`. Re-rendering the component — including on every keystroke of some unrelated state — sends nothing over the wire and does not make agents re-fetch `tools/list`.

**Your handler is always fresh.** The hook registers a stable wrapper that forwards to the handler from the latest render, so a handler that closes over component state sees the current value on the next call without being re-registered and without `useRef` workarounds:

```ts
const [cartId, setCartId] = useState<string | null>(null);

useCordieriteTool({
  name: "seed_cart",
  description: "Fill the current cart with test items",
  inputSchema: z.object({ items: z.number() }),
  // Reads whatever `cartId` was on the most recent render, no re-registration involved.
  handler: async ({ items }) => ({ cartId, added: items }),
});
```

**Hoisting schemas is a small optimization, not a requirement.** Schemas are compared by object identity first, so a schema defined at module scope (or wrapped in `useMemo`) is never re-exported to JSON Schema. A schema built inline in the component body is re-exported once per render to compare its shape — the same cost the old unconditional re-registration already paid — and still does not re-register unless the shape actually changed. Hoisting is worth a moment's thought for a hot component. (Builds that swap in the inert `./noop` entry never do any of this: that entry has no exporter at all, so it neither runs nor bundles JSON Schema export.)

A schema that does **not** export JSON Schema (zod 3, plain valibot — the same ones that get the "shapeless tool" dev warning) has no shape to compare, so it falls back to object identity: adding, swapping or removing one always re-registers, and one rebuilt inline on every render therefore re-registers on every render, exactly as it did before. Hoist it, or move to zod v4, whose built-in exporter puts it back on the cheap by-shape path.

Because exportable schemas are compared by their *exported* JSON Schema, the registry keeps the schema objects from the most recent registration: replacing one with an identity-different schema that exports the same JSON Schema keeps validating against the earlier object. That only matters for a validation rule JSON Schema cannot express *and* that closes over changing state (a `.refine()` reading component state, say) — pass `deps` for that case.

**Two mounted hooks registering the same tool name** were never a supported configuration (the registry dev-warns and the later registration overwrites the earlier). One consequence is worth knowing: when the later hook unmounts, the earlier one no longer re-claims the name on its next render, so the tool stays unregistered until that hook re-registers for its own reasons. Give each tool one owner.

**`deps` is an optional, advanced override.** Passing it replaces the derived key entirely with `useEffect`'s own semantics (`enabled` is still appended), which is occasionally useful — e.g. forcing a re-registration on something the descriptor does not capture. Most call sites should simply omit it. Pass it consistently if you pass it at all: alternating between passing `deps` and omitting it changes the dependency-array length between renders, which React warns about, exactly as it does for a hand-written `useEffect`.

**Keep both schemas object-rooted.** MCP's tool wire shape requires `inputSchema.type` and `outputSchema.type` to be the literal `"object"`, so `z.object({ ... })` (also `.passthrough()`/`z.looseObject(...)` and `z.record(...)`) is the only shape that survives to an agent intact. Anything else cannot be represented:

| Construct | Exports as | Object-rooted? |
| --- | --- | --- |
| `z.object({ ... })`, `.passthrough()`, `z.record(...)` | `type: "object"` | yes |
| `z.array(...)` | `type: "array"` | no |
| `z.string()`, `z.number()`, `z.boolean()`, `z.null()` | `type: "string"` etc. | no |
| `z.union([...])`, `z.object(...).nullable()` | `anyOf` | no — no root `type` at all |
| `z.discriminatedUnion(...)` | `oneOf` | no, even when every branch is an object |
| `z.intersection(a, b)` | `allOf` | no, even when both sides are objects |

A client validates the *whole* `tools/list` result, so one such schema would otherwise leave the agent with zero tools from your app. Cordierite degrades it instead:

| Schema | What Cordierite does |
| --- | --- |
| `outputSchema` MCP cannot accept | Drops it from `tools/list`. The tool stays listed and callable; its result arrives as JSON text, with no schema describing it (agents still get `structuredContent` when the result happens to be a JSON object, they just have nothing to validate it against). |
| `inputSchema` MCP cannot accept | Replaces it with a permissive empty object schema, so agents cannot see the tool's real arguments. MCP arguments are always an object, so the tool is not usefully callable this way ([#34](https://github.com/callstackincubator/cordierite/issues/34) tracks argument wrapping). |

Both log a dev warning naming the tool when it registers. That warning is a best-effort hint covering the root type only, which is everything zod itself can produce; MCP rejects a little more than that (a `properties` entry that is not an object subschema, such as the `{ a: true }` shorthand, or a `required` that is not an array), and those slip past it. **The authoritative signal is the `cordierite mcp:` notice on the MCP server's stderr** — it names the tool and quotes the SDK's own reason for rejecting the schema.

Wrap the value instead — `outputSchema: z.object({ todos: z.array(z.string()) })` rather than `z.array(z.string())` — and agents get the full shape, described and validated. `cordierite invoke`, `--json` output, and the JS client are unaffected either way: they carry the real schema and the raw result.

**Cancellation:** `handler(args, context)`'s `context.signal` (an `AbortSignal`) aborts if the caller cancels the call, or if the session's connection is lost mid-call. Forward it into anything that accepts one (`fetch(url, { signal: context.signal })`) or check `context.signal.aborted`/listen for `"abort"` to stop early. Ignoring it is fine — the handler just keeps running and replies normally, as it always has.

```ts
handler: async ({ url }, { signal }) => {
  const response = await fetch(url, { signal });
  return { body: await response.text() };
},
```

**Long-running tools:** a tool call gets 10 seconds by default. Declaring `timeoutMs` on the registration is the *only* way to raise that — a real `login()`, a `seedCart()` that hits your backend. That deadline is then the one enforced end to end: the app aborts the handler's `signal` at it, and it also travels to the daemon as the descriptor's `timeout_ms`, so an agent calling the tool over MCP (or `cordierite invoke` with no `--timeout`) gets the same budget instead of a `tool_timeout` at 10 s:

```ts
useCordieriteTool(
  {
    name: "login",
    description: "Signs a test user in against the real backend",
    timeoutMs: 60_000,
    handler: async ({ userId }, { signal }) => loginAsUser(userId, { signal }),
  },
  []
);
```

The SDK clamps the value to `[1_000, 600_000]` ms before either timer is set, so the handler's abort timer and the daemon's call deadline are always the same number (a value outside that range is clamped with a dev warning). A caller that passes its own timeout (`cordierite invoke --timeout`, `app.call(name, args, { timeoutMs })`) can **shorten** the deadline but cannot extend it past this one: the app aborts the handler at its own timer regardless — so for a tool that declares nothing, a caller asking for 60 s still gets the app's 10 s default. `createCordieriteClient`'s `defaultToolTimeoutMs` changes only that app-side fallback for tools that declare nothing; it is deliberately not sent to the daemon, so declare `timeoutMs` per tool when the host needs to know.

**Gating a tool by build variant:** `useCordieriteTool` takes a third `options` argument, `{ enabled?: boolean }` (default `true`). `enabled: false` never registers the tool, and removing it (or a hook that was already mounted) leaves no registration behind. Toggling `enabled` at runtime registers/unregisters cleanly — this is the supported way to make registration conditional, so put the condition in the argument instead of wrapping the hook call in an `if`, which is a rules-of-hooks violation:

```ts
useCordieriteTool(
  {
    name: "wipe-local-db",
    description: "Destructive: clears the local database",
    handler: async () => wipeLocalDb(),
  },
  // `options` is the third argument, so pass `undefined` for `deps` to keep the default
  // (register once per mount, re-register only when the descriptor changes).
  undefined,
  { enabled: process.env.EXPO_PUBLIC_CORDIERITE_TOOLS === "full" }
);
```

The recommended predicate is an app-owned build flag inlined by the bundler at build time (`EXPO_PUBLIC_*` env vars, a Babel define plugin, etc.) — something your release pipeline controls explicitly, like `process.env.EXPO_PUBLIC_CORDIERITE_TOOLS === "full"` above. **`__DEV__` is the wrong default here**, for the same reason a `debuggable` build-type check is the wrong native gate: `__DEV__` is `false` in *any* release-bundled JS, including the release-signed, internally-distributed "testing" variant agents actually drive in CI — gating a destructive tool on `__DEV__` removes it exactly where it is needed. `__DEV__` is still fine for tools that are genuinely debug-only (e.g. a "dump internal state" tool with no purpose outside a local dev loop); it just should not be the example every app copies for hardening.

**Consequence for agents and E2E flows:** because registration is the app-side allowlist, `tools/list` legitimately differs per build artifact — a CI testing build may expose a different tool set than a local dev build or a hardened production build. Automated flows should discover tools via `tools/list` rather than assume a fixed set is always present.

### 6. Start the daemon and test the flow

`cordierite` auto-spawns its daemon on first use, so most CLI commands just work:

```bash
cordierite link --qr
```

Scan the printed QR (or open the deep link) in the app, then inspect and invoke tools:

```bash
cordierite tools
cordierite invoke sum --input '{"a":2,"b":3}'
```

Omit the session selector when you only have one active session — `cordierite` uses it automatically; pass an alias or session id when you have several (`cordierite ls` lists them).

## Hardening for production / internal builds

Whether Cordierite's native code ships in a build, and what it trusts once it does, are two independent, explicit config decisions — neither is derived from whether the build is debuggable:

- **Inclusion** is decided entirely by autolinking (see "Compiling Cordierite out of production builds" below), not by anything this package does at runtime. By default the native module is present in **debug** builds and absent from **release** builds. The mechanism differs by platform: iOS restricts CocoaPods' `:configurations` to `Debug`, a real per-variant *linking* decision. Android can't use the equivalent `buildTypes` lever the same way — React Native's Gradle autolinking generates `PackageList.java` once, shared unfiltered across every variant, so restricting *linking* by variant would leave that shared file referencing a class absent from an unlisted variant's classpath (a compile error, not an inert build) — so Android links this project into every variant unconditionally, and `android/build.gradle` instead swaps which Kotlin source set compiles for the `release` build type, based on `CORDIERITE_ENABLED`: `debug` always compiles the real implementation, `release` compiles either the same real files (opted in) or a no-op `CordieritePackage` (default) that registers nothing. Either way, the real implementation is genuinely absent from the compiled output it's excluded from — not a `#if DEBUG`/`FLAG_DEBUGGABLE` check baked into code that ships regardless. `CordieritePackage.getModule` (Android) and `CordieriteTurboBridge.swift`/`RCTNativeCordierite.mm` (iOS) contain no build-type check at all — if the real implementation is compiled/linked into a variant, it's in that variant's build, full stop; whether it is is what `CORDIERITE_ENABLED` controls.
- **Trust** is decided by the `trust` config value: `"pin"` (only the embedded `cliPins` are trusted) or `"link"` (trust the bootstrap link's carried pin, per session — the "dev mode" flow from step 2 above). Default: `"pin"` when `cliPins` is non-empty, `"link"` otherwise. This resolution is identical in every build type; there is no `#if DEBUG`/`FLAG_DEBUGGABLE` involved anywhere in it.
- **A `trust` value that is neither `"link"` nor `"pin"`** (a typo, or a hand-edited native config) is a **hard error** — at config/prebuild time from the plugin, and independently in the native trust-resolution logic (`resolveTrustedPins` on both platforms) — so a typo can never silently downgrade an intended `"pin"` config into permissive link TOFU.
- **JS**: with the native module absent (excluded via autolinking, Expo Go, or a debug-tooling-free JS-only environment), every exported function on the root `@cordierite/react-native` entry degrades to the exact `./noop` entry's behavior — one warning log the first time, no throws, `getCordieriteState()` reporting `"idle"`, `connect()` always rejecting with `CordieriteDisabledError` (`code: "cordierite_disabled"`).

`trust: "pin"` requires non-empty `cliPins` (bare RN: `CordieriteTrust`/`TRUST` set to `"pin"` **and** `CordieriteCliPins`/`CLI_PINS` non-empty) — a build that only ever trusts embedded pins but has none configured would have no way to trust anything, so the plugin refuses that combination at config time, and the native readers refuse it again if that check is ever bypassed by hand.

**`getCordieriteBuildConfig()`** reports the effective trust configuration a running build actually has — `{ trust, hasEmbeddedPins, allowPrivateLanOnly }` — read via `getConstants()` from the exact same native manifest/plist parse `connect()`'s `resolveTrustedPins` uses, never a second parse path, so it can never disagree with what a real connect attempt would do. `trust` reports the *effective* bucket (`"pin"` whenever embedded pins are present, since they always win; `"link"` otherwise), not the raw config string. On `./noop`, it reports the documented absent shape: `{ trust: "absent", hasEmbeddedPins: false, allowPrivateLanOnly: true }`.

**Resulting matrix (`CORDIERITE_ENABLED` × build variant, `trust` orthogonal to both):**

| `CORDIERITE_ENABLED` | Debug / `debug` | Release / `release` |
| --- | --- | --- |
| unset (default) | Native code ships | Native code excluded |
| `1` / `true` | Native code ships | Native code ships |
| `0` / `false` | Native code excluded | Native code excluded |

`trust` (`"link"` vs `"pin"`, resolved as above) only matters in a variant where the native code ships at all.

## Compiling Cordierite out of production builds

**Debug builds carry Cordierite by default; release builds don't.** On iOS this is CocoaPods only linking the `Cordierite` pod into configurations named `Debug` (`react-native.config.js`'s `ios.configurations`). On Android, `android/build.gradle` compiles the real implementation for `debug` and a no-op stand-in for `release`, driven by the same `CORDIERITE_ENABLED` variable (see above) — the module is always linked as a Gradle project, but which Kotlin source set actually compiles for `release` is what changes. Neither is a runtime check. A release-signed internal/QA build that still needs Cordierite (an agent-driven CI build, for example) opts back in explicitly:

```bash
CORDIERITE_ENABLED=1 npx expo prebuild && CORDIERITE_ENABLED=1 npx expo run:ios --configuration Release
```

To go the other direction — strip Cordierite from a **debug** build too, or from every variant regardless of name — set `CORDIERITE_ENABLED=0`:

```bash
CORDIERITE_ENABLED=0 npx expo prebuild && CORDIERITE_ENABLED=0 npx expo run:ios --configuration Release
```

Accepted values are `1`/`true` and `0`/`false`, case-insensitive; unset or empty means the dev-only default described above. Any other value is a config error, raised at prebuild.

Cordierite ships its own `react-native.config.js` that reads the variable and sets `ios.configurations` in autolinking accordingly; `android/build.gradle` reads the same variable directly to pick the `release` source set (see above); and `@cordierite/react-native/metro` reads it too, to strip the JS (see "JS — swap the module at bundle time" below — Metro's own dev/release split does not thread through to this, so an explicit `CORDIERITE_ENABLED=0` is still how you strip Cordierite JS from a release bundle). One variable, every surface.

**`cordierite doctor`'s Android detection is marker-only.** The default release build's no-op `CordieritePackage` stub necessarily lives at the exact same fully-qualified class name the real implementation uses (that's what keeps `PackageList.java` compiling — see above), and the config plugin writes the same `AndroidManifest.xml` meta-data regardless of build variant. Both would otherwise look like "Cordierite is present" to a naive scan. `doctor` accounts for this: only the `CordieriteNativeMarker` keep-rule signal (absent from the stub) decides `present`/`absent` on Android; the other two signals are still reported for corroboration but can't flip the verdict on their own. See `packages/cordierite/src/artifact-inspect.ts`'s file-level comment for the full detection writeup.

**It must be set when autolinking resolves** — `pod install` and gradle configure — not merely when the app compiles. Flipping it and rebuilding without re-running install does nothing, silently.

**Keyed to build type by name, not by a compiled-in check.** CocoaPods restricts linking to Xcode configurations literally named `Debug`/`Release`; Gradle restricts it to build types literally named `debug`/`release`. A custom build-type/configuration name (a `staging` flavor, say) gets neither — set `CORDIERITE_ENABLED=1` for that pipeline if it should carry Cordierite. This replaces the `debuggable`/`#if DEBUG` gate removed in 0.4.0 with a real per-variant linking decision instead of a runtime check compiled into every variant.

Verify the result against the artifact rather than the build log:

```bash
cordierite doctor path/to/app-release.apk --assert-absent
```

When Cordierite *is* linked, its podspec and `build.gradle` print `[cordierite] native module INCLUDED in this build` during pod install / gradle configure. Nothing prints when it is excluded, because nothing runs — the line exists to catch a release build that carries Cordierite by mistake, which is the failure that matters. Treat `doctor` as the authority; the log is an early warning.

### Excluding it permanently, without the environment variable

If a project should never carry Cordierite on a given platform — regardless of pipeline — declare the exclusion in the app instead. In a `react-native.config.js` at your app root:

```js
module.exports = {
  dependencies: {
    "@cordierite/react-native": {
      platforms: {
        ios: null,
        android: null,
      },
    },
  },
};
```

The Expo-managed equivalent is `expo.autolinking`'s per-platform `exclude` list — but it must live in **`package.json`**, not `app.json` / `app.config.*`. `expo-modules-autolinking` reads this config straight from `package.json` at pod-install/gradle time; an `expo.autolinking` block in `app.json` is silently ignored, so the exclusion never happens and the native module still ships. This has already shipped as a bug once, so double-check with the resolver command below after adding it.

```json
{
  "expo": {
    "autolinking": {
      "ios": { "exclude": ["@cordierite/react-native"] },
      "android": { "exclude": ["@cordierite/react-native"] }
    }
  }
}
```

Verify the exclusion actually took effect — this is the only way to catch the `app.json` mistake above. Run it from your app root after `npm`/`pnpm`/`yarn install`, using the locally installed binary rather than `npx` (which can silently fetch an unrelated version from the registry instead of resolving the one your build actually uses):

```sh
./node_modules/.bin/expo-modules-autolinking react-native-config --json --platform ios
```

`@cordierite/react-native` must be absent from the printed `dependencies`.

> **`expo.autolinking.apple` overrides `expo.autolinking.ios`, not merges with it.** The CocoaPods driver `pod install` actually invokes always resolves with `--platform apple`, and when an `apple` sub-object is present under `expo.autolinking`, it wins outright over `ios` — `ios` is only used as a fallback when `apple` is absent. If your app also has an `expo.autolinking.apple` block (for reasons unrelated to Cordierite), an `ios`-only exclude for `@cordierite/react-native` is silently ignored on iOS; add the exclude to `apple` instead (or to both).

> **Excluding on iOS also disables codegen for this package.** `expo-modules-autolinking` only generates `CordieriteSpec` (the TurboModule codegen output `RCTNativeCordierite.mm` imports) for packages it actually autolinks. If your app excludes `@cordierite/react-native` from iOS autolinking but still references the `Cordierite` pod directly — for example to attach an XCTest target, as this repo's own playground does — the build fails because the generated header no longer exists. This only affects setups that both exclude and hand-add the pod; a normal consumer app that just wants Cordierite gone never hits it.

There is no corresponding plugin option to keep in sync. Earlier 0.4.0 prereleases had an `include` option that only *asserted* the plugin's intent matched autolinking; it was removed once `CORDIERITE_ENABLED` drove autolinking directly, since there were no longer two sources to reconcile. Passing it now throws at prebuild, naming the replacement.

**JS — swap the module at bundle time**, so no Cordierite JS (deep-link listener, tool registry, client state machine) ends up in the bundle either. Excluding the native module alone does not do this: the real JS entry is still bundled, it just finds no native module and goes inert. Use the `withCordierite` Metro helper from `@cordierite/react-native/metro` in `metro.config.js`:

```js
const { getDefaultConfig } = require("expo/metro-config");
const { withCordierite } = require("@cordierite/react-native/metro");

const config = getDefaultConfig(__dirname);

module.exports = withCordierite(getDefaultConfig(__dirname));
```

With no options it reads `CORDIERITE_ENABLED` itself, so the same variable that drops the native module strips the JS. Pass `{ include: false }` to force the strip, or `{ include: <your own predicate> }` to key it off something else entirely.

When stripping, every specifier this package exposes as a real JS module entry point (derived from `package.json`'s `exports`, not a hardcoded `.`/`/auto` list, so a future entry point is covered automatically) is redirected to `@cordierite/react-native/noop`, which has no side effect on import, matching `/auto`'s shape without installing anything. `/noop` itself is never redirected.

If `config.resolver.resolveRequest` is already set — as it typically will be, e.g. the playground's own workspace-symlink-dedup resolver — `withCordierite` **chains to it** for every resolution, redirected or not, instead of replacing it; it only falls back to `context.resolveRequest` when no existing resolver is present. Your existing resolver's return value is what callers see. **Call `withCordierite` last**, after anything else that sets `config.resolver.resolveRequest` — it captures the existing resolver by reference when called, so a later assignment overwrites (and silently discards) the strip instead of composing with it.

If you'd rather not touch Metro config, a conditional `require` at each import site works too (module identity differs per call site, so this is more repetitive but avoids any bundler-level indirection):

```ts
const { registerTool, useCordieriteTool } = __DEV__
  ? require("@cordierite/react-native")
  : require("@cordierite/react-native/noop");
```

Either way, `/noop` is typed identically to the root entry (both implement the same shared interface — see `src/public-api.ts` and `src/__tests__/noop-parity.test.ts`), so switching between them is a drop-in swap: `registerTool` still returns a disposer, `connect()` still returns a `Promise<void>` (it just always rejects with a `CordieriteDisabledError`, `code: "cordierite_disabled"`), and `getCordieriteState()` always reports `"idle"`.

**Either half alone still yields a working, inert app.** The `/noop` Metro swap alone gives you an app with no Cordierite JS running but the native pod still compiled in (unused); the autolinking exclude alone gives you an app with no native Cordierite code but that still imports the real JS entry, which finds no native module and degrades to the same `/noop`-equivalent behavior described in "Hardening for production / internal builds" above. `CORDIERITE_ENABLED=0` drives both halves at once, which is what you want to satisfy an app-store reviewer who expects no "remote control" surface whatsoever, not just an inert one.

## Platform compatibility

| Platform | Support |
| --- | --- |
| **iOS** | 15.1+ (`Cordierite.podspec`), New Architecture |
| **Android** | Autolinked, New Architecture |
| **Web** | Stub only |


## Made with ❤️ at Callstack

`cordierite` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[cordierite-banner]: https://img.shields.io/badge/Cordierite-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/cordierite
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=cordierite&utm_term=readme-with-love
[license-badge]: https://img.shields.io/npm/l/cordierite?style=for-the-badge
[license]: https://github.com/callstackincubator/cordierite/blob/main/LICENSE
[npm-downloads-badge]: https://img.shields.io/npm/dm/cordierite?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/cordierite
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: ./CONTRIBUTING.md
[chat-badge]: https://img.shields.io/discord/426714625279524876.svg?style=for-the-badge
[chat]: https://discord.gg/xgGt7KAjxv
