---
name: cordierite
description: Connect a Cordierite-enabled React Native app to your machine and drive it from the terminal using tools the app registers — useful for agents, scripts, and dev automation. Reach for this when the user mentions Cordierite, host/session pairing with the app, or invoking app-defined capabilities from the CLI.
---

# Cordierite

Cordierite is a CLI and host workflow for connecting to a Cordierite-enabled React Native app, discovering its registered tools, invoking those tools from the terminal, and ending the session cleanly after use.

## Agent workflow

1. Run **`cordierite session --json`**. The response includes **`data.sessions`** (each entry has **`session_id`**, status, endpoint info, etc.). If **`sessions`** is empty, no Cordierite host is registered for this machine (for this registry).
2. If you need a new session for a device, follow **Establish a session** below. **Record `host.session_id`** from the host JSON—you must pass it to **`tools`** and **`invoke`**.
3. After the user opens the deep link on the device and the app connects, confirm with **`cordierite session --session-id <session_id> --json`** until **`data.selected`** reflects an **active** connection (or re-check **`session --json`** and infer from the listed session).
4. **`cordierite tools --session-id <session_id> --json`** — list tools registered in the app.
5. **`cordierite tools --session-id <session_id> <tool-name> --json`** — inspect one tool’s input/output schema before calling it.
6. **`cordierite invoke --session-id <session_id> <tool-name> --input '{"key":"value"}' --json`** — invoke the tool with JSON args.

## Establish a session

Start the host with **`--json`** using the same TLS cert, key, and app URL scheme as the project (see **Setup** if you are wiring Cordierite into an app). If the default listen port is in use, add **`--port <port>`**.

```bash
cordierite host --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem --scheme myapp --json
```

**Run `cordierite host` in the background.** It blocks; keep the foreground shell free for `session`, `tools`, and `invoke`.

From the host JSON output, use at least:

- **`host.deep_link`** — full URL (e.g. `myapp:///?cordierite=…`) for the app to open.
- **`host.session_id`** — pass this as **`--session-id`** to **`tools`** / **`invoke`** / **`session --session-id`**.

Then:

1. **Give the user the deep link** (or QR from interactive host UI on a TTY) so they can open it on a device or simulator.
2. **Or open it yourself** when you know the target (e.g. iOS Simulator `xcrun simctl openurl booted '<url>'`, Android via `adb`, or device automation skills).

After the app opens the link and claims the session, poll **`cordierite session --session-id <session_id> --json`** (or **`session --json`**) until the session is active.

## Terminate the connection

When the user wants to disconnect or stop Cordierite for **that** session: **stop the matching background `cordierite host` process** (end the job, SIGTERM, etc.). That tears down the host and the session. If several hosts run (e.g. different **`--port`**), stop the one that corresponds to the **`session_id`** you were using.

## Declaring tools

The app must register tools before **`cordierite tools`** / **`cordierite invoke`** can do anything useful. Define schemas with **Zod** and register with **`registerTool`**:

```ts
import { registerTool } from "@cordierite/react-native";
import { z } from "zod";

const echoInput = z.object({
  value: z.unknown(),
});

const echoOutput = z.object({
  echoed: z.unknown(),
});

registerTool(
  {
    name: "echo",
    description: "Return the input unchanged",
    input_schema: echoInput,
    output_schema: echoOutput,
  },
  async (args) => ({ echoed: args.value }),
);
```

## Notes

- Use **`--json`** for structured CLI output in agent flows.
- **`tools`** and **`invoke`** always require **`--session-id`** (the value from **`host.session_id`** or **`sessions[].session_id`**).
- Prefer **`cordierite session --json`** first rather than assuming a session exists.
- If **`sessions`** is empty or **`tools`** / **`invoke`** fail with connection or session errors, establish a session (host running, deep link opened on the correct device).
- If the app registers no tools, **`cordierite tools`** returns an empty list.
- You may run **multiple** **`cordierite host`** processes (e.g. different **`--port`** for different devices); use the **`session_id`** that belongs to the host you care about.

## Setup

For project integration guidance, see [setup.md](./references/setup.md).

