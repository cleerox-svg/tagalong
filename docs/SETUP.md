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

## 1c. Price-drop emails (phase 3)

Saved trips with alerts on are re-checked by a Cron Trigger every 6 hours
(`23 */6 * * *` in `apps/api/wrangler.jsonc`), at most 5 trips per run and each
trip at most every 12 hours, until its event date. A drop of 2% or more below
the best price seen is recorded and shown under **My trips**. To also email it:

1. resend.com → Domains → add `averrow.com` and create the DNS records it lists
   (SPF/DKIM) on the averrow.com zone. Emails come from
   `ALERT_FROM_EMAIL` in `apps/api/wrangler.jsonc` (`alerts@averrow.com`).
2. resend.com → API Keys → create a key with **sending access** only, then:

```sh
cd apps/api
pnpm exec wrangler secret put RESEND_API_KEY
```

Without the key, alerts are still recorded and shown in the app; nothing is
emailed. Re-checks use the same providers as a manual re-check, so with live
price keys set each scheduled check costs one Duffel and one Booking.com
search per stay window.

Exchange rates come from the European Central Bank's daily reference rates via
`api.frankfurter.dev`, which needs no key.

## 1d. Eventbrite links (phase 4)

Optional. Pasted Eventbrite links work without it: the event page's own
schema.org data is read instead. With a token, Budgetrip reads the event and
its ticket price range from the Eventbrite API, which is more reliable:

```sh
cd apps/api
pnpm exec wrangler secret put EVENTBRITE_TOKEN
```

| Secret             | Where it comes from                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `EVENTBRITE_TOKEN` | eventbrite.com → Account settings → Developer links → API keys → create a key, then copy its **private token**. |

Eventbrite retired public event search in 2020, so Eventbrite events come in by
link only; **Browse events** searches Ticketmaster.

Other pasted links are fetched from the Worker with a `BudgetripBot` user
agent. Only public http(s) hosts on default ports are fetched (no IP addresses,
internal names or `averrow.com`), every redirect is re-checked, and pages are
cut off at 1.5 MB and 8 seconds.

### Local development

Put the same names in `apps/api/.dev.vars` (git-ignored) with your own dev
values, then:

```sh
pnpm db:migrate:local
pnpm dev     # API on :8787, web app on :5173
```

## 1e. Tagalong moderators (phase 5)

The Tagalong moderation queue (open reports, removing messages, suspending and
trusting users) is open only to the users listed in `MODERATOR_USER_IDS` in
`apps/api/wrangler.jsonc`: a comma-separated list of user UUIDs (the `id`
column of `users`, not emails). It is configuration, not a secret, so change it
in a PR:

```jsonc
"MODERATOR_USER_IDS": "6f1c2e9a-…-0001,b27d…-0002",
```

To find someone's id, have them sign in once, then look them up by email in
`users` (Cloudflare dashboard → D1 → `tagalong-db` → Console). Empty (the
default) means nobody can open the queue: every moderation request answers 403.
It fails closed. Reports are still recorded and wait in the queue.

The chat fan-out runs in a Durable Object, `ChatRoom` (binding `CHAT_ROOM`). No
setup is needed: the first deploy that includes it creates the class from the
`v1` entry under `migrations` in `apps/api/wrangler.jsonc`. That list is
append-only, like `/migrations`: never edit or remove a tag.

## 1f. Mobile push (phase 6)

Optional. Push notifications on the Android and iOS apps go through Firebase
Cloud Messaging (FCM HTTP v1); Firebase relays iOS notifications to APNs.
Without the secret below nothing is pushed and the app works as before.

1. console.firebase.google.com → **Add project** (Analytics not needed). In
   that project add an **Android app** and an **iOS app** with the
   Capacitor app id, `com.averrow.budgetrip` (`apps/web/capacitor.config.ts`),
   as both the Android package name and the iOS bundle id.
2. Firebase console → Project settings → **Cloud Messaging** → Apple app
   configuration → upload an **APNs authentication key** (`.p8`, from
   developer.apple.com → Certificates, IDs & Profiles → Keys, with Apple Push
   Notifications service enabled) with its Key ID and your Team ID.
3. console.cloud.google.com (same project) → IAM & Admin → **Service
   accounts** → create one (e.g. `tagalong-push`) with only the **Firebase
   Cloud Messaging API Admin** role (`roles/firebasecloudmessaging.admin`).
   Keys → Add key → JSON, and save the file outside the repository.
4. Store the whole JSON file as the Worker secret, then delete the local copy:

```sh
cd apps/api
pnpm exec wrangler secret put FCM_SERVICE_ACCOUNT_JSON < /path/to/service-account.json
```

| Secret                     | Where it comes from                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `FCM_SERVICE_ACCOUNT_JSON` | The service-account JSON key from step 3 (`project_id`, `client_email`, `private_key`). |

A value that is not valid JSON, or lacks one of those fields, is treated as
unset: pushes are skipped and the Worker logs why (never the key itself).

5. For local native builds, download the Firebase app config files and put
   them in the native projects: `google-services.json` in `apps/web/android/app/`
   and `GoogleService-Info.plist` in `apps/web/ios/App/App/`. They are
   gitignored; **never commit them**. Each developer keeps their own copy.

### Mobile sign-in: verified HTTPS callback (done in phase 7)

Native sign-in (Google and Apple) hands the one-time code back to the app on
a fixed, verified HTTPS link, `https://tagalong.averrow.com/auth/app-callback`
(`NATIVE_CALLBACK` in `apps/api/src/auth/native.ts`), an Android App Link and
iOS Universal Link. The OS opens it only in the app the domain vouches for, so
no other installed app can receive the code (the old custom scheme could be
claimed by anyone). The code is still single-use, 60 s, and PKCE-bound.

After sign-in the API shows a short page on `tagalong-api.averrow.com`
("Signed in as … — Open Budgetrip"). That tap is deliberate: a user tap on a
link to a different domain is what reliably makes iOS and Android open the
app rather than the website. If the app isn't installed, the link opens the
web app's `/auth/app-callback` page. A native sign-in that fails (cancelled,
expired, rate limited, …) shows the same kind of page ("Sign-in didn't
finish — …") with a **Return to Budgetrip** link to the same fixed URL with
`?error=<code>`, for the same reason.

The four sign-in endpoints (`/auth/google/start`, `/auth/google/callback`,
`/auth/apple/start`, `/auth/apple/callback`) are limited to 20 requests a
minute per IP each (by `CF-Connecting-IP`): the web gets a 429, the app the
error page with `error=rate_limited`.

Owner fill-ins before the store builds (the web app serves both files from
`apps/web/public/.well-known/`):

- **iOS:** in `apple-app-site-association`, replace the Team ID placeholder
  with your 10-character Team ID (developer.apple.com → Membership). On the
  App ID `com.averrow.budgetrip` enable the **Associated Domains**
  capability; the app's entitlement is `applinks:tagalong.averrow.com`.
- **Android:** in `assetlinks.json`, list the SHA-256 certificate
  fingerprints of **both** the release key and your debug key. For the
  release key use the **App signing key** fingerprint from Play Console →
  your app → Test and release → App integrity → App signing (Play App Signing
  re-signs the app, so your upload key's fingerprint is not enough).
- **Cloudflare:** the OS fetches these files without a browser, so a bot
  challenge breaks verification silently. On the averrow.com zone add a WAF
  custom rule that **skips** all managed rules / Bot Fight Mode / Super Bot
  Fight Mode for `http.host eq "tagalong.averrow.com" and starts_with(http.request.uri.path, "/.well-known/")`,
  and make sure they are served as `application/json` with no redirect.
- Add the `hold` label to the PR that fills these in.

## 1g. Sign in with Apple (phase 7)

The App Store requires Sign in with Apple in an app that offers Google
sign-in. It works on the web and in the app (the same `form_post` flow in the
system browser). Until it is configured, `/auth/apple/start` answers 500
`misconfigured` (the app gets `error=misconfigured`): it fails closed.

1. developer.apple.com → Certificates, IDs & Profiles → **Identifiers** →
   the App ID `com.averrow.budgetrip` → enable **Sign in with Apple** (and
   **Associated Domains**, see above).
2. Identifiers → **+** → **Services IDs** → e.g.
   `com.averrow.budgetrip.signin`. Enable Sign in with Apple → Configure:
   primary App ID `com.averrow.budgetrip`; **Domains and Subdomains**
   `tagalong-api.averrow.com`; **Return URLs**
   `https://tagalong-api.averrow.com/auth/apple/callback`. (Apple accepts
   only HTTPS return URLs, so Apple sign-in can't be tried on
   `http://localhost:8787`.)
3. **Keys** → **+** → enable Sign in with Apple (primary App ID as above) →
   download `AuthKey_XXXXXXXXXX.p8` (once only) and note its **Key ID**.
   Your **Team ID** is under Membership.
4. Put the three non-secret values in `apps/api/wrangler.jsonc` in a PR (with
   the `hold` label), and the key as a secret, then delete the local `.p8`:

```sh
cd apps/api
pnpm exec wrangler secret put APPLE_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8
```

| Name                | Kind                       | Value                                                            |
| ------------------- | -------------------------- | ---------------------------------------------------------------- |
| `APPLE_SERVICES_ID` | var (`wrangler.jsonc`)     | The Services ID from step 2, e.g. `com.averrow.budgetrip.signin` |
| `APPLE_TEAM_ID`     | var (`wrangler.jsonc`)     | Your 10-character Team ID                                        |
| `APPLE_KEY_ID`      | var (`wrangler.jsonc`)     | The Key ID of the `.p8` from step 3                              |
| `APPLE_PRIVATE_KEY` | secret (`wrangler secret`) | The whole `.p8` file (PKCS8 PEM)                                 |

5. **Private email relay.** Users can hide their address; Apple then gives
   us `…@privaterelay.appleid.com`, and Apple only relays mail from senders
   you register. Certificates, IDs & Profiles → **Services** → **Sign in with
   Apple for Email Communication** → Configure → add the domain
   `averrow.com` and the address `alerts@averrow.com`. The domain must pass
   SPF (and should have DKIM), which the Resend records from §1c already
   provide. Without this, price-drop emails to relay addresses bounce.

An Apple sign-in always has its own account: it is never linked to a Google
account with the same email (an email match isn't proof it's the same person,
and relay addresses never match anyway). `GET /me` lists
`sign_in_providers`. Apple's refresh token is stored encrypted (AES-GCM, key
derived from `SESSION_SECRET`) only so it can be revoked when the account is
deleted; rotating `SESSION_SECRET` just means that revoke is skipped.

## 1h. Account deletion (phase 7)

Signed-in users can delete their account in the app (the **Delete account**
section of their account screen, typing DELETE), as both stores require: `POST /me/delete`. It runs
as one database transaction and signs the user out everywhere (cookie, app
token, chat sockets).

| Deleted                                                                | Kept                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Trip requests, plans, packages, saved trips, share links, price alerts | The `users` row as a tombstone: email, names, home city and Tagalong profile cleared; shown as "Deleted user" |
| Push devices, notification settings, pending app sign-in codes         | Reports filed by and against the user                                                                         |
| Group memberships and blocks (both ways); open connections are closed  | The text of any of their messages that was reported (for moderation; hidden from chat)                        |
| Their other messages: hidden, text replaced with `[message deleted]`   | The Tagalong suspension marker, if they were suspended                                                        |
| The Sign in with Apple grant (revoked at Apple, best effort)           | Suspended accounts only: a keyed hash of each sign-in identity (see below)                                    |

Signing in again with the same Google or Apple account creates a new, empty
account.

**Suspended accounts.** So that deleting an account can't be used to get
around a Tagalong suspension, when a suspended user deletes their account we
keep, for each way they signed in, a keyed hash of that sign-in identity
(HMAC-SHA256 of the Google or Apple account id, keyed from `SESSION_SECRET`)
and the suspension date, in `suspended_identities` (migration
`0010_suspended_identities`). Nothing else: no email, name or raw account id.
A new account created by the same Google or Apple account starts suspended
from Tagalong (the rest of Budgetrip works as normal). Nothing is kept for
accounts that were not suspended. Rotating `SESSION_SECRET` makes the stored
hashes unmatchable.

## Phase 7 (store readiness) in short

Sign in with Apple (§1g), the HTTPS app callback (§1f), and in-app account
deletion (§1h). Migration `0009_store_readiness` adds `users.apple_sub`,
`apple_refresh_token_enc` and `deleted_at`; `0010_suspended_identities` keeps
suspensions across delete and re-sign-up (§1h). Owner steps: §1g items 1-5 and the
fill-ins under "Mobile sign-in" above.

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
