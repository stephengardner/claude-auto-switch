# Contributing

## Setup

```
npm install
npm run verify   # typecheck + lint + tests
```

Node 20 or newer is required.

## Ground rules

- **Test-driven.** Write a failing test first, then the minimal code to pass it.
  Pure logic (config, selector, ledger, parsers) is unit-tested; the whole
  rotation loop is tested against the fake `claude` in `test/fake-claude/`.
- **Never spend real model tokens or perform real logins in tests.** Use the
  fake `claude`.
- **Never commit credentials or profile folders.** `ccx doctor` and `.gitignore`
  guard this; keep it that way.
- **Keep units small and focused.** Pure logic stays separate from side effects;
  inject paths, the clock, and the claude invoker so everything is deterministic.
- **Conventional commits** (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).

## Before opening a PR

- `npm run verify` is green.
- New behavior has tests.
- No secrets added to the tree.
