# Tagalong

**Budgetrip** plans event trips that fit a budget; **Tagalong** (phase 5) is the
social layer on top. The plan, principles and phases are in
[`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md) — read it first.

Phase 1 (Budgetrip MVP) is in: Google sign-in → a trip request (form or free
text, confirmed by the user) → a Ticketmaster event lookup → transport and
lodging as labelled estimates → up to five ranked packages under budget.

Phase 2 (live prices) adds real flight prices from Duffel and hotel prices
from Booking.com when their keys are set (falling back to labelled estimates
otherwise), and a "Re-check prices" button.

## Stack

| Layer    | Choice                                |
| -------- | ------------------------------------- |
| Monorepo | pnpm workspaces + Turborepo           |
| API      | Cloudflare Worker (Hono)              |
| Web      | Vite + React PWA (assets-only Worker) |
| Database | Cloudflare D1 (`tagalong-db`)         |
| CI/CD    | GitHub Actions, auto-merge            |

## Layout

```
apps/api/         Hono Worker        → tagalong-api.averrow.com
apps/web/         Vite + React PWA   → tagalong.averrow.com
packages/shared/  types, money, estimate tables, ranking (pure, tested)
packages/config/  shared tsconfig
migrations/       numbered D1 SQL migrations — APPEND ONLY
scripts/          CI helpers
```

## Develop

```sh
pnpm install
pnpm db:migrate:local    # apply migrations to a local D1
pnpm dev                 # API on :8787, web on :5173 (needs apps/api/.dev.vars, see docs/SETUP.md)
```

## Check

```sh
pnpm turbo run lint typecheck test build
```

## Ship

1. Branch, commit, open a PR (draft while in progress).
2. CI runs: append-only migration guard, format, lint, typecheck, tests, build,
   local D1 migration dry-run.
3. When CI is green and the PR is not a draft (and has no `hold` label), it
   merges itself (`auto-merge.yml`).
4. The merge deploys: D1 migrations, then the Worker, then a smoke test that
   checks the live version is this commit.

One-time setup (secrets, branch protection): see `docs/SETUP.md`.
