# Tagalong

Groundwork for the Tagalong application. The product plan is still to come; this
repo currently holds the platform skeleton only.

## Stack

| Layer    | Choice                        |
| -------- | ----------------------------- |
| Monorepo | pnpm workspaces + Turborepo   |
| API      | Cloudflare Worker (Hono)      |
| Database | Cloudflare D1 (`tagalong-db`) |
| CI/CD    | GitHub Actions, auto-merge    |

## Layout

```
apps/api/         Hono Worker        → tagalong-api (workers.dev for now)
packages/config/  shared tsconfig
migrations/       numbered D1 SQL migrations — APPEND ONLY
scripts/          CI helpers
```

## Develop

```sh
pnpm install
pnpm db:migrate:local    # apply migrations to a local D1
pnpm dev                 # API on :8787 — try http://localhost:8787/health
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
