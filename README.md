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

## Live end-to-end

`e2e/` boots the real server (`bun run src/index.ts`) on an ephemeral port with a throwaway
SQLite file and drives it over HTTP only (`POST /messages` SSE, `POST /pearls`,
`GET /pearls/:id/data`). It is skipped unless `LIVE=1`, so plain `bun test` stays offline.

```sh
LIVE=1 bun test e2e
```

- `e2e/citibike.test.ts` (ENSURE-1) and `e2e/decline.test.ts` talk to the real model: they need
  `OPENROUTER_API_KEY` and are skipped without it. Each run costs three conversations.
- `e2e/builtins.test.ts` (ENSURE-2) uses no model: it saves each built-in's example Pearl and
  refreshes it at all four sizes. `recurse` needs `RC_PAT` and `markets` needs `COINGECKO_API_KEY`;
  each is skipped with the missing key named when unset.
