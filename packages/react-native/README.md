[![Cordierite][cordierite-banner]][repo]

### Tools and state from outside the app—without debug menus

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

This package is the **native client** for Cordierite. Your app **registers tools** in JavaScript; **developers, testers, and agents** invoke them from a **CLI or host** once the app opens a bootstrap link and completes a **pinned `wss://`** handshake — TLS + SPKI transport instead of **debug-only screens** in the UI.

## Why use it

- **No in-app debug chrome**: drive screens, flags, fixtures, and flows from the **host**, not from hidden menus shipped to users.
- **Same path for people and automation**: CLI for devs/QA, agents for scripted or LLM-driven control — both use **tool calls** after session claim.
- **Production-capable**: ship it in real builds when your pins and operational model allow; connecting still needs a **trusted host**, not anonymous access.

## Getting started

> [!NOTE]
> Use a **development build** or bare native app. **Expo Go** is not enough—this library ships native code and pinning configuration.

### 1. Install

The app-side package plus a schema library:

```bash
npm install @cordierite/react-native zod
```

The CLI, on the machine running the host:

```bash
npm install -g cordierite
```

### 2. Nothing to configure yet

**No key, no pins, and no config plugin are needed — in any build type.** The daemon auto-generates a key on first start, and `cordierite link` carries its `sha256/...` fingerprint on the deep link for the app to trust for that session.

Wire your deep-link scheme so the OS can open the app with that link. To make a build trust only pins you embedded ahead of time, see [Configuring trust](https://github.com/callstackincubator/cordierite/blob/main/docs/SECURITY.md#configuring-trust).

By default the native module ships in **debug** builds only: a Release build has none, so the API is inert and `connect()` rejects `cordierite_disabled` ([Build variants](https://github.com/callstackincubator/cordierite/blob/main/docs/BUILD-VARIANTS.md)).

### 3. Import Cordierite in the JS entry point

```ts
import "@cordierite/react-native/auto";
```

`/auto` is the only entry that installs anything: the deep-link bootstrap listener and native-lease recovery. To control *when* — in `__DEV__`, behind a QA toggle — `require()` it there instead. Metro resolves it lazily; importing twice installs once:

```ts
if (__DEV__) {
  require("@cordierite/react-native/auto");
}
```

The default flow needs no `Linking` handler of your own, and sessions survive Metro reloads and network flaps — see [ARCHITECTURE.md §11](https://github.com/callstackincubator/cordierite/blob/main/docs/ARCHITECTURE.md#11-react-native-sdk) for lease, resume, and reconnect rules.

If you drive bootstrap yourself and never import `/auto`, call `restoreSession()` before your own bootstrap handling — it is then the only reader of the native resume lease.

### 4. Define tools in app startup code

Call `registerTool({ ... })` with Standard Schema compatible `inputSchema`/`outputSchema` values and a `handler`. Zod v4 works well — its JSON Schema exporter means agents see a real tool shape. Zod 3 and plain valibot schemas still register, with a dev warning and an empty schema.

`useCordieriteTool` wraps `registerTool` in a `useEffect`, so registration follows the component's lifecycle, remounts and Fast Refresh included:

```ts
import "@cordierite/react-native/auto";
import { useCordieriteTool } from "@cordierite/react-native";
import { z } from "zod";

export function CordieriteBootstrap() {
  useCordieriteTool(
    {
      name: "sum",
      description: "Add two numeric values",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ total: z.number() }),
      handler: async ({ a, b }) => ({ total: a + b }),
    },
    []
  );

  return null;
}
```

Mount it near app startup, or register from a module that loads then. The host can only invoke tools your app already registered.

To keep a destructive tool out of some build variants, pass `{ enabled }` rather than wrapping the hook in an `if` ([Gating a tool by build variant](https://github.com/callstackincubator/cordierite/blob/main/docs/SECURITY.md#gating-a-tool-by-build-variant)).

### 5. Start the daemon and test the flow

`cordierite` auto-spawns its daemon. `link` needs your app's deep-link scheme: pass `--scheme` (matching `expo.scheme`), or set `scheme` once in `~/.cordierite/config.json`:

```bash
cordierite link --scheme myapp --qr
```

Scan the QR (or open the link) in the app, then list and invoke tools:

```bash
cordierite tools
cordierite invoke sum --input '{"a":2,"b":3}'
```

Omit the session selector when only one session is active; pass an alias or session id when several are (`cordierite ls`).

## API reference

### Entry points

| Entry | Behavior |
| --- | --- |
| `@cordierite/react-native` | Side-effect-free. The native module is looked up **lazily**, on the first native call, so importing it (even in Expo Go) never crashes. |
| `@cordierite/react-native/auto` | Same exports plus one side effect: installs the deep-link bootstrap listener and starts lease recovery — the only entry that installs anything. |
| `@cordierite/react-native/noop` | Same public API, fully inert — for [compiling Cordierite out of production builds](https://github.com/callstackincubator/cordierite/blob/main/docs/BUILD-VARIANTS.md#compiling-cordierite-out-of-production-builds). |
| `@cordierite/react-native/metro` | `withCordierite(config, { include })` — swaps the real entries for `/noop` at bundle time. |

### Exports

| Export | Signature / notes |
| --- | --- |
| `registerTool` | `({ name, description, inputSchema?, outputSchema?, annotations?, handler })` → `{ remove() }`. The disposer removes only its own registration. |
| `useCordieriteTool` | `(definition, deps?, { enabled? })`. `enabled` defaults to `true`; `false` never registers, and removes any registration that hook owns. |
| `handler` | `(args, context)`. `context.signal` is an `AbortSignal`, aborted when the caller cancels or the connection drops mid-call. Forward it (`fetch(url, { signal })`), check `signal.aborted`, or listen for `"abort"`; ignoring it is fine — the handler replies normally. |
| `postEvent` | `(name, payload?)` — pushes an app event, read by `cordierite events` and the MCP event tools. |
| `addCordieriteListener` | `(kind, callback)` → `{ remove() }`. Kinds `"stateChange"`, `"sessionChange"`, `"error"` — the last one unified channel for bootstrap-parse, connect, socket, and tool-handler failures. |
| `getRegisteredTools` | → `ToolDescriptor[]`, the current registry. |
| `getCordieriteState` | → the client's connection state (`"idle"` with no session). |
| `restoreSession` | → `Promise<boolean>`. Recovers the native resume lease; also on `cordieriteClient`. |
| `connect` | `(input)` → `Promise<void>`. Claims a parsed bootstrap payload; rejects with `CordieriteDisabledError` (`code: "cordierite_disabled"`) when native is absent. |
| `parseBootstrapUrl` | Parses a v2 bootstrap deep link (and its sibling `pin` param) for `connect`. |
| `getCordieriteBuildConfig` | → `{ trust, hasEmbeddedPins, allowPrivateLanOnly }`, this build's [effective trust configuration](https://github.com/callstackincubator/cordierite/blob/main/docs/SECURITY.md#reading-the-effective-configuration-at-runtime). |

## Going further

- [Trust modes](https://github.com/callstackincubator/cordierite/blob/main/docs/SECURITY.md#trust-modes) and [Configuring trust](https://github.com/callstackincubator/cordierite/blob/main/docs/SECURITY.md#configuring-trust) — pins, plugin options, bare-RN native keys.
- [Gating a tool by build variant](https://github.com/callstackincubator/cordierite/blob/main/docs/SECURITY.md#gating-a-tool-by-build-variant) — `enabled`, and why `__DEV__` is wrong here.
- [Build variants](https://github.com/callstackincubator/cordierite/blob/main/docs/BUILD-VARIANTS.md) — `CORDIERITE_ENABLED`, autolinking exclusion, **compiling Cordierite out of production builds**.
- [What a build without the native module does](https://github.com/callstackincubator/cordierite/blob/main/docs/SECURITY.md#what-a-build-without-the-native-module-does).
- [Release gate: `cordierite doctor`](https://github.com/callstackincubator/cordierite/blob/main/docs/CI.md#release-gate-cordierite-doctor).
- [ARCHITECTURE.md §11](https://github.com/callstackincubator/cordierite/blob/main/docs/ARCHITECTURE.md#11-react-native-sdk) — resume lease, reconnect, cancellation.
- [`cordierite` CLI and MCP server](https://github.com/callstackincubator/cordierite/blob/main/packages/cordierite/README.md).

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
[prs-welcome]: https://github.com/callstackincubator/cordierite/pulls
[chat-badge]: https://img.shields.io/discord/426714625279524876.svg?style=for-the-badge
[chat]: https://discord.gg/xgGt7KAjxv
