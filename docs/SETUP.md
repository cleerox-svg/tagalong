# One-time setup

## 1. Cloudflare

Already done: the Worker `tagalong-api` is deployed on
`https://tagalong-api.averrow.com`, and the D1 database `tagalong-db`
(`d31489d3-930e-4fed-b961-239f3f1aaebc`) exists and is wired into
`apps/api/wrangler.jsonc`.

## 2. GitHub repository secrets

Settings → Secrets and variables → Actions → **Secrets**:

| Secret                  | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | API token with **Workers Scripts: Edit** and **D1: Edit** on the account |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account ID                                                |

The same token BVOM uses works if it carries those permissions.

The token also needs **Zone → Workers Routes: Edit** (and **DNS: Edit**) on the
`averrow.com` zone, because the Worker is served on the Custom Domain
`tagalong-api.averrow.com` and the deploy creates that route and DNS record.

The deploy smoke test checks `https://tagalong-api.averrow.com/health`. If the
averrow.com zone shows CI a bot challenge, that check reports UNVERIFIED as a
warning rather than failing; add a WAF skip rule for the hostname to clear it.

## 3. Let Actions merge

Settings → Actions → General → Workflow permissions: **Read and write
permissions**. (The workflows also request what they need explicitly; this
setting must not forbid it.)

## 4. Protect `main` (recommended)

Settings → Branches → add a rule (or ruleset) for `main`:

- Require a pull request before merging (0 approvals — auto-merge is the
  reviewer of record for green PRs).
- Require status checks: **Migrations are append-only** and
  **Lint / Typecheck / Test / Build**.
- Do not allow bypassing for anyone except admins.

If you later require 1+ approvals, auto-merge will skip PRs until they are
approved.

## 5. Create the `hold` label

Issues → Labels → New label `hold`. A PR carrying it never auto-merges.
