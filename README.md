### Let agents and tests reach into your running app — without shipping a debug menu

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

Cordierite lets a terminal, a test runner, or an AI agent call functions inside your React Native app while it's running. You pick what's callable — a few functions you write yourself — and nothing else is reachable.

## Why you'd want this

**Your E2E tests stop tapping through setup.** Most of an end-to-end test isn't the thing you're testing. It's logging in, dismissing onboarding, seeding a cart, waiting for a spinner. With Cordierite, the test calls `login(userId)` or `seedCart(items)` directly and jumps straight to the part that matters. Faster runs, far less flakiness, and a lot fewer screenshots for an agent to burn tokens on.

**Agents can actually drive your app.** Add one line to Claude Code's or Cursor's config and your app's functions show up as tools the agent can call. It can flip a feature flag, jump to a screen, or check some state without you wiring up a single prompt.

**No hidden debug UI.** No secret gestures, no long-press-the-logo admin panel, nothing extra in the app for someone to go find. The only things reachable are functions you deliberately registered.

**It works in whatever build you want.** Dev, internal, TestFlight, production — Cordierite isn't tied to debug builds. You decide which builds carry it and what those builds are willing to trust. Most teams ship it in dev and internal builds and strip it from store releases, but that's your call, not something the library decides for you.

**Your dev loop doesn't fight you.** Metro reloads, backgrounding the app, flaky Wi-Fi — the session survives all of it and picks back up on its own. One background service handles as many devices as you've got plugged in.

## What it looks like

Register something you want reachable:

```ts
import { useCordieriteTool } from "@cordierite/react-native";
import { z } from "zod";

useCordieriteTool({
  name: "seed_cart",
  description: "Fill the cart with test items.",
  inputSchema: z.object({ items: z.number() }),
  handler: async ({ items }) => ({ added: items }),
});
```

The hook registers once per mount — re-rendering costs nothing for a schema that exports JSON
Schema (Zod 4, ArkType) or is hoisted out of the component, and the handler always sees the latest
state it closes over. The [package README](packages/react-native/README.md#5-define-tools-in-app-startup-code)
covers the one exception, schemas that cannot export JSON Schema.

Call it from your terminal:

```bash
cordierite invoke seed_cart --input '{"items":3}'
```

Or hand it to an agent:

```json
{
  "mcpServers": {
    "cordierite": { "command": "cordierite", "args": ["mcp"] }
  }
}
```

Both read your app's deep-link scheme from `app.json`'s `expo.scheme`, so from your app's root directory there is nothing to configure. The CLI is normally run from there; an MCP client is not, and it starts the server in whatever working directory it likes — so give that entry its own scheme with `args: ["mcp", "--scheme", "myapp"]`, or set `CORDIERITE_SCHEME`. Running `cordierite init` once in the app root prints exactly that entry with the scheme filled in.

That's the whole idea. Everything else is about which builds include it and what they trust.

## Is this safe to ship?

That's the right question to ask, and the honest answer is: it depends on how you set it up, so it's worth ten minutes of reading before you ship it in something customers install.

The short version: the connection is encrypted, your app checks the identity of the machine on the other end rather than trusting whoever's on the network, and a link someone intercepts isn't a way in. On top of that, you choose per build whether Cordierite's code is even in the binary. In development none of this needs configuring — it just works — and you tighten it up for builds that leave your machine.

[`docs/SECURITY.md`](docs/SECURITY.md) walks through what it protects against, what it doesn't, and how to rotate keys.

## Getting started

Install the CLI where you'll run it, and the package in your app:

```bash
npm install -g cordierite
npm install @cordierite/react-native zod
```

From there:

- **[Set up your app](packages/react-native/README.md)** — registering tools, deep-link setup, and how to decide what ships in which build.
- **[Use the CLI and MCP server](packages/cordierite/README.md)** — connecting to a device, listing and calling tools, and checking a built artifact.
- **[Try the playground](playground/README.md)** — a working app you can run end to end in a few minutes. Fastest way to see whether this fits your project.

You'll need a development build or a bare React Native app. Expo Go can't do it.

## Packages

| Package | What it is |
| --- | --- |
| [`cordierite`](packages/cordierite/README.md) | The CLI, the background service, and the MCP server |
| [`@cordierite/react-native`](packages/react-native/README.md) | The app-side library and Expo config plugin |
| [`@cordierite/shared`](packages/shared/README.md) | Types shared by both |

## Support

iOS 15.1+ and Android, both on the New Architecture. Web gets a no-op stub so shared code doesn't break. The CLI needs Node 20 or newer. Windows works in principle but isn't tested in CI yet.

## Docs

- [`docs/SECURITY.md`](docs/SECURITY.md) — what it protects against, and key rotation
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pieces fit together
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the wire protocol, if you're implementing a client
- [`docs/CI.md`](docs/CI.md) — running it in CI

## Made with ❤️ at Callstack

`cordierite` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

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
