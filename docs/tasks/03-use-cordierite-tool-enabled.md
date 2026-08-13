# 03 — `useCordieriteTool({ enabled })`

**Wave 1. Depends on 01. JS only — no shared files with any other task.**

## Goal

An app can register a tool in some build variants and not others, without violating the
rules of hooks and without the library needing a policy engine.

## Why

Registration *is* the app-side allowlist — the only enforcement point that sits inside the
trust boundary. Daemon-side policy runs on the operator's machine, which `docs/SECURITY.md`
already names as the boundary itself, so it is operator ergonomics rather than a production
control (task 09 fixes the docs that imply otherwise).

Today that pattern is awkward: `if (__DEV__) useCordieriteTool(...)` is a rules-of-hooks
lint error even though a compile-time constant makes it safe in practice. Moving the
condition into the argument makes the supported thing also the obvious thing.

## Scope

`packages/react-native/src/useCordieriteTool.ts` (and the `createUseCordieriteTool` factory
shared with `noop.ts`, so both entries keep identical shape):

```ts
useCordieriteTool(definition, deps?, options?: { enabled?: boolean })
```

- `enabled` defaults to `true`.
- `false` → no registration, and any existing registration from this hook is removed.
- Toggling at runtime registers/unregisters; it must not leak a registration or remove a
  different hook's tool (registrations already compare by identity, not name — keep that).
- Mirror the option in `noop.ts` so `__tests__/noop-parity.test.ts` still passes.

Consider whether `registerTool` needs anything — it probably does not; callers can branch
normally outside React.

## Documentation (in this task, not deferred to 09)

- Show the **recommended predicate**: an app-owned build flag inlined by the bundler, e.g.
  `process.env.EXPO_PUBLIC_CORDIERITE_TOOLS === "full"`.
- State explicitly that **`__DEV__` is the wrong default** for this, for the same reason
  `debuggable` was the wrong gate: it is `false` in any release-bundled JS, including the CI
  testing variant agents drive — so gating destructive tools on `__DEV__` removes them
  exactly where they are needed. `__DEV__` is fine for genuinely debug-only tools; it must
  not be the headline example.
- Note the consequence for agents: `tools/list` legitimately differs per artifact, so E2E
  flows should discover tools rather than assume them.

## Acceptance

- Unit tests: default-on; `enabled: false` never registers; `true → false` removes;
  `false → true` registers; toggling twice leaves exactly one registration.
- `__tests__/noop-parity.test.ts` and the public-API type test still pass.
- No ESLint `rules-of-hooks` suppression anywhere in the new docs snippets.
