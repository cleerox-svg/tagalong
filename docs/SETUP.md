# One-time setup

## 1. Cloudflare

Already done: the Worker `tagalong-api` is deployed on
`https://tagalong-api.averrow.com`, and the D1 database `tagalong-db`
(`d31489d3-930e-4fed-b961-239f3f1aaebc`) exists and is wired into
`apps/api/wrangler.jsonc`.

The web app deploys as a second, assets-only Worker, `tagalong-web`, on the
Custom Domain `https://tagalong.averrow.com`. The first deploy after phase 1
merges creates that route and DNS record (same token permissions as the API).

## 1a. API Worker secrets (phase 1)

Set once per secret, from `apps/api`; they persist across deploys and never go
in a file:

```sh
cd apps/api
openssl rand -base64 48 | pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put ANTHROPIC_API_KEY
pnpm exec wrangler secret put TICKETMASTER_API_KEY
pnpm exec wrangler secret put GOOGLE_MAPS_API_KEY
```

| Secret                 | Where it comes from                                                                                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`       | Random, 32+ characters (the command above). Rotating it signs everyone out.                                                                                                                                                                                                                                |
| `GOOGLE_CLIENT_ID`     | Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type **Web application**. Authorised redirect URIs: `https://tagalong-api.averrow.com/auth/google/callback` and, for local dev, `http://localhost:8787/auth/google/callback`. Consent screen scopes: `openid`, `email`, `profile`. |
| `GOOGLE_CLIENT_SECRET` | The same OAuth client.                                                                                                                                                                                                                                                                                     |
| `ANTHROPIC_API_KEY`    | console.anthropic.com → API keys. Used only to read a free-text trip request into form fields.                                                                                                                                                                                                             |
| `TICKETMASTER_API_KEY` | developer.ticketmaster.com → My Apps → Consumer Key (Discovery API).                                                                                                                                                                                                                                       |
| `GOOGLE_MAPS_API_KEY`  | Google Cloud Console → a key with **Places API (New)** enabled. Restrict it to that API. It is used server-side only, so do not add an HTTP-referrer restriction.                                                                                                                                          |

Until these are set, `/health` stays green but sign-in and planning answer
"not configured".

## 1b. Live prices (phase 2)

Optional: without them, flights and hotels stay labelled estimates and each
plan says "live prices aren't switched on yet". Add them when the accounts
exist:

```sh
cd apps/api
pnpm exec wrangler secret put DUFFEL_ACCESS_TOKEN
pnpm exec wrangler secret put BOOKING_API_TOKEN
pnpm exec wrangler secret put BOOKING_AFFILIATE_ID
```

| Secret                 | Where it comes from                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DUFFEL_ACCESS_TOKEN`  | app.duffel.com → Developers → Access tokens. A `duffel_test_…` token works straight away and returns sandbox offers (e.g. "Duffel Airways"); switch to a `duffel_live_…` token once the account is verified. |
| `BOOKING_API_TOKEN`    | Booking.com Demand API, from the affiliate partner account (requires an approved partnership).                                                                                                               |
| `BOOKING_AFFILIATE_ID` | The same Booking.com affiliate account.                                                                                                                                                                      |

To try Booking.com's sandbox, change `BOOKING_API_BASE` in
`apps/api/wrangler.jsonc` to `https://demandapi-sandbox.booking.com/3.1` in a
PR. It is not a secret.

Budgetrip shows these prices and links out; it never books through Duffel or
Booking.com (spec §2.2).

Exchange rates come from the European Central Bank's daily reference rates via
`api.frankfurter.dev`, which needs no key.

### Local development

Put the same names in `apps/api/.dev.vars` (git-ignored) with your own dev
values, then:

```sh
pnpm db:migrate:local
pnpm dev     # API on :8787, web app on :5173
```

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
