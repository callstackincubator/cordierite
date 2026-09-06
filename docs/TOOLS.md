# Registering tools

How the app side of Cordierite publishes tools: the schema forms it accepts, what the
`useCordieriteTool` hook actually re-registers, the shape MCP requires, and how long a call
may run. The five-minute version lives in the
[package README](../packages/react-native/README.md#4-define-tools-in-app-startup-code); keeping a
destructive tool out of a build variant is [its own
section](./SECURITY.md#gating-a-tool-by-build-variant) of the security model.

## Accepted schema forms
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

## Registration is per mount, not per render
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

## Keep both schemas object-rooted
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

## Long-running tools
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
