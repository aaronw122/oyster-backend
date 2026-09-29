# oyster-backend

TypeScript backend for Oyster (Bun + zod).

## Setup

```sh
bun install
bun test          # run tests
bun run typecheck # tsc --noEmit
```

## Layout

- `src/contract/` — zod schemas and inferred types for the owner-approved API contract
  (Pearl, WidgetOutput, PearlData, ChatEvent, request/response bodies, `SIZE_BUDGETS`).
- `fixtures/contract/` — canonical JSON fixtures for every contract type. The iOS repo copies
  these verbatim; keep file names and contents stable.

Widget text budgets (`SIZE_BUDGETS`) are measured in Unicode code points.
