# Store listing and data safety (phase 8)

What to put in App Store Connect and the Google Play Console, built from the
code. Every claim names the file it comes from (paths are from the repo root).
If the code changes, update this file in the same PR. Where an answer depends
on a choice only the owner can make, it is under **Owner decisions** (§8) and
is not answered here.

Contact (support and privacy, both stores): **support@averrow.com**.
Placeholder still to fill: `{{CONTROLLER}}` (the legal entity responsible for
the data, and its country; §8).

Public URLs (served by the web app on `https://tagalong.averrow.com`):

| Page            | URL                                         |
| --------------- | ------------------------------------------- |
| Support         | https://tagalong.averrow.com/support        |
| Privacy policy  | https://tagalong.averrow.com/privacy        |
| Terms           | https://tagalong.averrow.com/terms          |
| Account removal | https://tagalong.averrow.com/delete-account |

---

## 1. Data inventory

"Deleted" means removed by in-app account deletion, `POST /me/delete`
(`apps/api/src/routes/account.ts`), which runs as one D1 batch. None of the
tables below has a time-based expiry unless the Retention column says so:
data stays until the user deletes it or deletes their account.

**Processors** are services that handle data for us under their own API terms:
Anthropic, Google (Places, Firebase Cloud Messaging), Apple (APNs, Sign in
with Apple), Duffel, Booking.com, Ticketmaster, Eventbrite, Resend and
Cloudflare (hosting, D1, logs). Google and Apple sign-in are where the account
identity comes from. Frankfurter (exchange rates) receives currency codes
only (`apps/api/src/providers/frankfurter.ts`).

### 1a. Account (`users`)

| Data                                                            | Stored in                                                                                                          | Purpose                                                                                                                    | Sent to                                                                                                       | Retention                                                                                                                | On account deletion                                                                          | Source                                                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email address                                                   | `users.email`                                                                                                      | Account identity; shown to the user on their account screen; recipient of price-drop emails                                | Comes from Google or Apple sign-in. Sent to Resend only when a price-drop email goes out                      | Until deletion. Updated on every Google sign-in; an Apple sign-in updates it only when Apple supplies a verified address | Cleared (`''`)                                                                               | `migrations/0002_budgetrip.sql`; `apps/api/src/auth/routes.ts` (`googleUser`, `appleUser`); `apps/api/src/routes/account.ts`                                                                   |
| Apple private relay address                                     | `users.email`                                                                                                      | As above. Stored only when Apple marks the email verified; otherwise the account has no email and no alert emails are sent | Resend, as above                                                                                              | As above                                                                                                                 | Cleared                                                                                      | `apps/api/src/auth/routes.ts` (`appleUser`); `apps/api/src/planning/alerts.ts` ("an Apple account that shared no email address")                                                               |
| Display name                                                    | `users.display_name`                                                                                               | Account label for the user. Not shown to other users (Tagalong shows `tagalong_name`)                                      | Comes from Google's `name` claim or Apple's first-sign-in name, else the email's local part, else "Traveller" | Until deletion                                                                                                           | Replaced with "Deleted user"                                                                 | `apps/api/src/auth/routes.ts`; `apps/api/src/tagalong/access.ts`                                                                                                                               |
| Home city                                                       | `users.home_city`                                                                                                  | Default for the Tagalong city field. Declared as approximate location (§2, §4)                                             | None                                                                                                          | Until deletion                                                                                                           | Cleared                                                                                      | Accepted by `POST /me/onboarding` (`apps/api/src/auth/routes.ts`), but the current onboarding screen does not send it (`apps/web/src/Onboarding.tsx`). Read in `apps/web/src/TagalongGate.tsx` |
| Home coordinates                                                | `users.home_lat`, `users.home_lng`                                                                                 | None. The columns exist, but no code writes them, so they are always NULL                                                  | None                                                                                                          | n/a                                                                                                                      | Cleared                                                                                      | `migrations/0002_budgetrip.sql`; no writer anywhere in `apps/api/src`                                                                                                                          |
| Home currency                                                   | `users.home_currency`                                                                                              | Default budget currency                                                                                                    | None                                                                                                          | Until deletion                                                                                                           | Cleared                                                                                      | `apps/api/src/auth/routes.ts` (`/me/onboarding`)                                                                                                                                               |
| 18+ confirmation                                                | `users.birthdate_verified_18`, `users.age_confirmed_at`                                                            | 18+ self-declaration, needed before planning or Tagalong. No birthdate is collected                                        | None                                                                                                          | Until deletion                                                                                                           | Reset to 0 / NULL                                                                            | `apps/api/src/auth/routes.ts`; `apps/api/src/auth/session.ts` (`requireAdult`)                                                                                                                 |
| Google account id                                               | `users.google_sub`                                                                                                 | Sign-in                                                                                                                    | Comes from Google                                                                                             | Until deletion                                                                                                           | Replaced by `deleted:<id>`                                                                   | `migrations/0002_budgetrip.sql`, `migrations/0009_store_readiness.sql`; `apps/api/src/routes/account.ts`                                                                                       |
| Apple account id                                                | `users.apple_sub`                                                                                                  | Sign-in                                                                                                                    | Comes from Apple                                                                                              | Until deletion                                                                                                           | Cleared                                                                                      | `migrations/0009_store_readiness.sql`; `apps/api/src/routes/account.ts`                                                                                                                        |
| Apple refresh token                                             | `users.apple_refresh_token_enc` (AES-GCM, key derived from `SESSION_SECRET`)                                       | Kept only to revoke the Sign in with Apple grant when the account is deleted                                               | Sent to Apple's revoke endpoint at deletion                                                                   | Until deletion                                                                                                           | Revoked at Apple (best effort), then cleared                                                 | `migrations/0009_store_readiness.sql`; `apps/api/src/auth/apple.ts`; `apps/api/src/routes/account.ts`                                                                                          |
| Account id, `created_at`, `deleted_at`, `tagalong_suspended_at` | `users`                                                                                                            | Tombstone that reports, moderation history and message authorship point at                                                 | None                                                                                                          | Indefinitely (tombstone)                                                                                                 | **Kept**                                                                                     | `migrations/0009_store_readiness.sql`; `apps/api/src/routes/account.ts`                                                                                                                        |
| Sign-in session                                                 | No server store. Web: signed HttpOnly cookie `tg_session`. App: signed bearer token in the device's secure storage | Keeping the user signed in                                                                                                 | None                                                                                                          | 30 days (`SESSION_DAYS`)                                                                                                 | Every credential stops working: the account check rejects a tombstone. The cookie is cleared | `apps/api/src/auth/session.ts`; `apps/web/src/native.ts` (`capacitor-secure-storage-plugin`)                                                                                                   |
| App sign-in codes                                               | `native_auth_codes` (SHA-256 of the code, PKCE challenge, expiry)                                                  | Hand a browser sign-in back to the app                                                                                     | None                                                                                                          | 60 s, single use. Expired rows are purged (up to 100 at a time, once over an hour old) on later exchanges                | Deleted                                                                                      | `migrations/0008_push_notifications.sql`; `apps/api/src/auth/native.ts`                                                                                                                        |

### 1b. Budgetrip (planning, saved trips, alerts)

| Data                                                                                                                                                                                                                                                                                                 | Stored in                                                                                                                                | Purpose                                                                                                                                    | Sent to                                                                                                                      | Retention                                                      | On account deletion       | Source                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Trip request free text (up to 2,000 characters)                                                                                                                                                                                                                                                      | Parse step: not stored. If the user then plans, the client sends it with the confirmed form and it is stored in `trip_requests.raw_text` | Turn a description into form fields the user checks before planning                                                                        | **Anthropic** (with today's date, inside delimiters; schema-constrained reply, no prices). Nothing else is sent to Anthropic | Until deletion                                                 | Deleted                   | `apps/api/src/routes/plans.ts` (`/trip-requests/parse`, `/plans`); `apps/api/src/providers/anthropic.ts`; `apps/web/src/form.ts` |
| Confirmed trip request: origin city label, its centre coordinates (from Google Places, 4 decimal places), origin country, event search text, event city, dates, party size, budget, preferences (transport, stay, seats, vibe tags, **accessibility notes up to 500 characters**), pasted event link | `trip_requests` (`prefs_json` holds preferences)                                                                                         | Planning, re-checks, scheduled price checks                                                                                                | Subsets go to the providers below                                                                                            | Until deletion                                                 | Deleted                   | `migrations/0002_budgetrip.sql`, `migrations/0005_any_event.sql`; `apps/api/src/routes/plans.ts`; `packages/shared/src/types.ts` |
| Plans, packages, package items (prices with source and `fetched_at`)                                                                                                                                                                                                                                 | `plans`, `packages`, `package_items`                                                                                                     | Show the ranked packages                                                                                                                   | None                                                                                                                         | Until deletion                                                 | Deleted                   | `migrations/0002_budgetrip.sql`; `apps/api/src/routes/account.ts`                                                                |
| Saved trips                                                                                                                                                                                                                                                                                          | `saved_trips`                                                                                                                            | My trips, price-drop checks                                                                                                                | None                                                                                                                         | Until deletion                                                 | Deleted                   | `migrations/0004_saved_trips_shares_alerts.sql`                                                                                  |
| Share links                                                                                                                                                                                                                                                                                          | `share_links` (token, plan, owner, `revoked_at`)                                                                                         | Read-only public view of one plan. It shows the plan, origin city and budget fields, without coordinates, free text or accessibility notes | Anyone with the link                                                                                                         | Until deletion. A revoked link's row is kept with `revoked_at` | Deleted                   | `migrations/0004_saved_trips_shares_alerts.sql`; `apps/api/src/routes/trips.ts` (`/shared/:token`)                               |
| Price-drop alerts                                                                                                                                                                                                                                                                                    | `price_alerts` (old/new total, currency, emailed/pushed status and error)                                                                | Alert history under My trips                                                                                                               | Resend (email) and FCM (push), below                                                                                         | Until deletion                                                 | Deleted                   | `migrations/0004_saved_trips_shares_alerts.sql`, `migrations/0008_push_notifications.sql`; `apps/api/src/planning/alerts.ts`     |
| City search text (up to 120 characters)                                                                                                                                                                                                                                                              | Not in D1. Cached in Cloudflare's Workers Cache, keyed by the lowercased text, not by user                                               | Origin city lookup                                                                                                                         | **Google Places** (Text Search, `locality` only)                                                                             | Cache: up to 7 days                                            | Not linked to the account | `apps/api/src/providers/google-places.ts`; `apps/api/src/routes/plans.ts` (`/places`)                                            |
| Event search: keyword, city, date range. Category browse: a geohash (precision 7) of the chosen city's centre, radius, dates, category                                                                                                                                                               | Workers Cache, keyed by the query                                                                                                        | Find the event                                                                                                                             | **Ticketmaster** Discovery API                                                                                               | Cache: 15 min                                                  | Not linked                | `apps/api/src/providers/ticketmaster.ts`; `apps/api/src/routes/events.ts`                                                        |
| Pasted Eventbrite link: the event id                                                                                                                                                                                                                                                                 | Workers Cache                                                                                                                            | Read the event                                                                                                                             | **Eventbrite** API (only when `EVENTBRITE_TOKEN` is set)                                                                     | Cache: 15 min                                                  | Not linked                | `apps/api/src/providers/eventbrite.ts`                                                                                           |
| Other pasted event links                                                                                                                                                                                                                                                                             | The page is fetched by the Worker (user agent `BudgetripBot`), not by the user's device                                                  | Read the page's schema.org Event                                                                                                           | The page's own site (a request from Cloudflare, with no user data)                                                           | Cache: 30 min                                                  | Not linked                | `apps/api/src/providers/event-page.ts`                                                                                           |
| Flight search: origin city centre and venue coordinates rounded to 2 decimal places, airport codes, dates, number of adults                                                                                                                                                                          | Workers Cache                                                                                                                            | Live flight prices                                                                                                                         | **Duffel**                                                                                                                   | Cache: airports 30 days, offers 10 min                         | Not linked                | `apps/api/src/providers/duffel.ts`; `apps/api/src/planning/live.ts`                                                              |
| Hotel search: venue coordinates (5 km radius), dates, adults, rooms, budget currency, booker country (the trip's origin country)                                                                                                                                                                     | Workers Cache                                                                                                                            | Live hotel prices                                                                                                                          | **Booking.com** Demand API                                                                                                   | Cache: 15 min                                                  | Not linked                | `apps/api/src/providers/booking.ts`; `apps/api/src/planning/live.ts`                                                             |
| User-described events ("tell us the date and city"): the typed event name, city and date                                                                                                                                                                                                             | `events`, a shared table that is not scoped to a user (row id = hash of the text)                                                        | Plan an event no provider lists                                                                                                            | None                                                                                                                         | Indefinitely                                                   | **Not deleted** (see §8)  | `apps/api/src/planning/events.ts` (`describedEvent`); `apps/api/src/planning/run.ts`                                             |
| Price-drop email: recipient address, event name (or the user's event search text), old and new price, plan link                                                                                                                                                                                      | `price_alerts.emailed_at`, `email_error`                                                                                                 | Tell the user a saved trip got cheaper                                                                                                     | **Resend**, from `alerts@averrow.com`                                                                                        | Until deletion                                                 | Deleted                   | `apps/api/src/planning/alerts.ts`; `apps/api/src/providers/resend.ts`; `apps/api/wrangler.jsonc` (`ALERT_FROM_EMAIL`)            |

### 1c. Push notifications (app only)

| Data                               | Stored in                                                                                                        | Purpose                                                                                                                                                                                                        | Sent to                                                                  | Retention                                                                                                                                                                        | On account deletion | Source                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| Push token and platform            | `push_devices` (token, platform, created/last seen, `disabled_at`, `last_error` with provider status codes only) | Deliver notifications                                                                                                                                                                                          | **Firebase Cloud Messaging**, which relays iOS notifications to **APNs** | Removed when the user signs out on that device. A dead token is disabled but kept until the device registers again or the account is deleted. At most 10 active devices per user | Deleted             | `migrations/0008_push_notifications.sql`; `apps/api/src/routes/push.ts`; `apps/api/src/push/dispatch.ts` |
| Notification text                  | Not stored                                                                                                       | Title and body carry only a Tagalong display name, an event name or a stored price. The data payload holds the notification kind and an in-app path with ids. **Never a message body, a location or an email** | FCM / APNs                                                               | n/a                                                                                                                                                                              | n/a                 | `apps/api/src/push/dispatch.ts` (header comment, `plan`, `dispatchPriceDrop`)                            |
| Notification preferences, throttle | `notification_prefs`, `push_throttle`                                                                            | Opt-outs per kind; one push per room per 5 minutes                                                                                                                                                             | None                                                                     | Until deletion                                                                                                                                                                   | Deleted             | `migrations/0008_push_notifications.sql`                                                                 |

### 1d. Tagalong (opt-in social layer, 18+)

| Data                                                                                                                                       | Stored in                                                                                                            | Purpose                                                                     | Sent to                                                                                                              | Retention                                                                                                           | On account deletion                                                                                                 | Source                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Tagalong profile: first name (up to 40), city name only (no numbers, coordinates or addresses), opt-in, safety-note and trusted timestamps | `users.tagalong_*`                                                                                                   | What other members see. Never the email, Google/Apple name or home location | Other members of shared groups or connections                                                                        | Until deletion. **Opting out keeps the name and city**; only `tagalong_opt_in_at` is cleared                        | Cleared (the suspension marker is kept)                                                                             | `migrations/0006_tagalong.sql`; `apps/api/src/routes/tagalong.ts`; `packages/shared/src/tagalong.ts`                                         |
| Group memberships and interest line (up to 140, no links or emails)                                                                        | `group_members`                                                                                                      | Event groups                                                                | Other group members                                                                                                  | Until the user leaves, opts out or is suspended                                                                     | Deleted                                                                                                             | `migrations/0006_tagalong.sql`; `apps/api/src/tagalong/leave.ts`                                                                             |
| Connections (pair, status, who asked, timestamps)                                                                                          | `connections`                                                                                                        | Mutual connect before DMs                                                   | The other person                                                                                                     | Until deletion                                                                                                      | Open ones are closed; **the rows are kept**                                                                         | `migrations/0006_tagalong.sql`; `apps/api/src/tagalong/leave.ts`                                                                             |
| Group and DM messages (up to 1,000 characters)                                                                                             | `messages` (the only store; the `ChatRoom` Durable Object only relays to open sockets)                               | Chat                                                                        | Group members / the other person in a DM                                                                             | Until deletion. **Deleting your own message hides it but keeps the text** (for moderation)                          | Hidden and text replaced with `[message deleted]`, **except** a reported message, whose text is kept for moderation | `migrations/0006_tagalong.sql`; `apps/api/src/tagalong/messages.ts` (`deleteOwnMessage`); `apps/api/src/routes/account.ts`                   |
| Blocks                                                                                                                                     | `blocks`                                                                                                             | Hide both ways                                                              | None                                                                                                                 | Until removed                                                                                                       | Deleted (both directions)                                                                                           | `migrations/0006_tagalong.sql`; `apps/api/src/routes/account.ts`                                                                             |
| Reports (reporter, target, reason, optional details up to 1,000) and resolutions                                                           | `reports`                                                                                                            | Moderation queue                                                            | Moderators (the users in `MODERATOR_USER_IDS`), who see Tagalong names and cities only, never email or home location | **Indefinitely**                                                                                                    | **Kept**, both by and against the user                                                                              | `migrations/0006_tagalong.sql`; `apps/api/src/tagalong/reports.ts`; `apps/api/wrangler.jsonc`                                                |
| Suspension                                                                                                                                 | `users.tagalong_suspended_at`                                                                                        | Removes Tagalong access                                                     | None                                                                                                                 | Indefinitely                                                                                                        | **Kept** on the tombstone                                                                                           | `apps/api/src/tagalong/reports.ts` (`suspendUser`); `apps/api/src/routes/account.ts`                                                         |
| Suspended identities                                                                                                                       | `suspended_identities` (keyed HMAC-SHA256 of the Google/Apple account id, suspension date). No email, name or raw id | Stop a suspended user from deleting and re-joining to lift a suspension     | None                                                                                                                 | **Indefinitely** (no pruning). Written only when a suspended account is deleted; nothing is kept for other accounts | Created by deletion (suspended accounts only)                                                                       | `migrations/0010_suspended_identities.sql`; `apps/api/src/auth/suspended-identity.ts`; `apps/api/src/routes/account.ts`; `docs/SETUP.md` §1h |

### 1e. Security and operations

| Data                         | Stored in                                                                                                                                                                                                                                                           | Purpose                                                                        | Sent to    | Retention                                                                                                                                                                                                                                       | On account deletion                            | Source                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IP addresses                 | `rate_limits.key` as `ip:<scope>:<IP>`, with a counter. Used on the four sign-in endpoints, the app code exchange and public share links. Rows written before the `ip:` prefix existed used `shared:`, `native-exchange:` and `signin:` and are pruned the same way | Abuse prevention (rate limiting) only                                          | None       | **Kept at most 24 hours** (the privacy policy's promise). In practice at most 7 hours: IP windows are 1 hour or less, the prune deletes an IP row once its window started more than 1 hour ago, and it runs every 6 hours (cron `23 */6 * * *`) | Not linked to an account                       | `apps/api/src/lib/rate-limit.ts` (`rateLimitByIp`, `pruneRateLimits`, `LEGACY_IP_KEY_PREFIXES`); `apps/api/src/auth/routes.ts`; `apps/api/src/auth/native.ts`; `apps/api/src/routes/trips.ts`; `apps/api/src/index.ts` (`scheduled`); `apps/api/wrangler.jsonc` (`triggers`) |
| Per-user rate-limit counters | `rate_limits.key` as `<scope>:<user id>`                                                                                                                                                                                                                            | Rate limits on planning, Tagalong joins, messages, connects, reports and so on | None       | Deleted by the same prune once the window started more than 24 hours ago (no window is longer), so at most 30 hours after it started                                                                                                            | Not deleted directly; expire through the prune | `apps/api/src/lib/rate-limit.ts`; `apps/api/src/tagalong/limits.ts`; `apps/api/wrangler.jsonc` (`triggers`)                                                                                                                                                                  |
| Worker logs                  | Cloudflare Workers Logs: `observability.enabled: true`, `head_sampling_rate: 1` (every request)                                                                                                                                                                     | Diagnosing errors                                                              | Cloudflare | Set by Cloudflare's plan, not by this repo (see §8)                                                                                                                                                                                             | Not deleted                                    | `apps/api/wrangler.jsonc`. The web Worker has no observability block (`apps/web/wrangler.jsonc`)                                                                                                                                                                             |

**What the API logs.** Every `console.*` call in `apps/api/src` (tests excluded):

| Call                                                                                                                                                                 | Logs                                                                                                                                      | Personal data?                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `index.ts` `console.error("unhandled error", err)`                                                                                                                   | Any non-HTTP error a route throws (name, message, stack): typically a D1 error or an Anthropic SDK error (status, Anthropic's error body) | No email, IP or message content is put into these errors by our code. Third-party error text is not ours to control |
| `index.ts` `console.log("saved-trip price check", r)`                                                                                                                | `{ checked, alerts }` counts                                                                                                              | No                                                                                                                  |
| `index.ts` `console.error("saved-trip price check failed", err)`                                                                                                     | The error                                                                                                                                 | No                                                                                                                  |
| `index.ts` `console.log("rate-limit prune", { deleted })` / `console.error("rate-limit prune failed")`                                                               | A row count / a fixed message (deliberately not the error, which could quote an IP key)                                                   | No                                                                                                                  |
| `planning/run.ts` `console.error("plan failed", planId, err)`                                                                                                        | Plan UUID and the error (`ProviderError` messages are the provider name and an HTTP status; the FX one adds currency codes)               | Plan id only                                                                                                        |
| `planning/live.ts` `console.warn("duffel offer failed", r.reason)`, `console.warn("duffel unavailable", err)`, `console.warn("booking.com search failed", r.reason)` | Provider name and HTTP status, or a timeout                                                                                               | No                                                                                                                  |
| `planning/alerts.ts` `console.warn("price check failed for a saved trip", …)`                                                                                        | Error name and the first 200 characters of its message; deliberately no user id, email or trip                                            | No                                                                                                                  |
| `planning/alerts.ts` `console.warn("price alert email failed", alertId, err)`                                                                                        | Alert UUID and `resend: HTTP <status>` or a timeout                                                                                       | Alert id only; **not** the email address                                                                            |
| `providers/fcm.ts` `console.warn("fcm push disabled:", reason)`                                                                                                      | Which field of the service-account config is missing or malformed                                                                         | No (never the key or a device token)                                                                                |
| `auth/routes.ts` `console.error("native sign-in failed", err)`                                                                                                       | An unexpected error during app sign-in (D1 or crypto)                                                                                     | No                                                                                                                  |
| `auth/native.ts` `console.error("native code cleanup failed", err)`                                                                                                  | A D1 error                                                                                                                                | No                                                                                                                  |
| `chat/notify.ts` `console.error("chat broadcast failed", room, err)`, `console.error("chat kick failed", room, err)`                                                 | Room name (`group:<uuid>` or `dm:<uuid>`) and the Durable Object error                                                                    | Room id only; never message text                                                                                    |
| `push/dispatch.ts` `console.error("push throttle release failed", err)`, `console.error("push dispatch failed", event.kind, err)`                                    | Notification kind and the error                                                                                                           | No                                                                                                                  |
| `routes/account.ts` `console.warn("account delete: Apple token not revoked", { userId })`                                                                            | The internal user UUID                                                                                                                    | **User id** (a random UUID, not an email)                                                                           |

So the API never logs an email address, an IP address or message content
itself. Two things land in Workers Logs anyway, because Cloudflare records each
request's own details (per Cloudflare's Workers Logs documentation; check the
fields in the dashboard): the request URL, which can contain a city search
(`/places?q=…`), browse coordinates (`/events/browse?lat=…`), a one-time
Google sign-in code (`/auth/google/callback?code=…`), a chat ticket
(`/chat/…/ws?ticket=…`) or a share token (`/shared/<token>`); and connection
metadata such as the client IP.

---

## 2. Apple App Privacy (App Store Connect)

**Tracking: No.** There is no advertising, analytics, crash-reporting or
attribution SDK in the app or API (searched `apps/web`, `apps/api/src`,
`packages/shared`), no IDFA use, and `NSPrivacyTracking` is false
(`apps/web/ios/App/App/PrivacyInfo.xcprivacy`). No data is used for
third-party advertising, developer advertising or marketing, analytics or
product personalisation.

**Data collected.** Every type is **linked to the user** (stored against the
account) and **not used for tracking**. The only purpose is **App
Functionality**: Apple's definition covers authentication, features, fraud
prevention and security, which includes moderation.

| Apple data type                        | What it is here                                                                                   | Linked | Tracking | Purposes          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ | -------- | ----------------- |
| Contact Info → Email Address           | Sign-in email; price-drop emails                                                                  | Yes    | No       | App Functionality |
| Contact Info → Name                    | Display name from Google/Apple; Tagalong first name shown to other members                        | Yes    | No       | App Functionality |
| User Content → Emails or Text Messages | Tagalong group chat and direct messages                                                           | Yes    | No       | App Functionality |
| User Content → Other User Content      | Trip description, accessibility notes, pasted event links, Tagalong interest line, report details | Yes    | No       | App Functionality |
| Search History                         | Event searches and trip requests (event, cities, dates, budget) saved with the account            | Yes    | No       | App Functionality |
| Identifiers → User ID                  | Account id, Google/Apple account id                                                               | Yes    | No       | App Functionality |
| Identifiers → Device ID                | Push notification token                                                                           | Yes    | No       | App Functionality |
| Location → Coarse Location             | Cities the user types or picks (see below). Never read from the device                            | Yes    | No       | App Functionality |
| Other Data → Other Data Types          | 18+ self-declaration, home currency                                                               | Yes    | No       | App Functionality |

**Coarse Location (owner decision, §8).** The app never reads device
location. The cities it stores against the account are declared as coarse
location: the trip origin (the typed or picked city's label, plus that city
centre's coordinates from Google Places, 4 decimal places, in
`trip_requests`; `apps/api/src/routes/plans.ts`), the Tagalong city shown to
others (`users.tagalong_city`; `apps/api/src/routes/tagalong.ts`) and the
home city (`users.home_city`, accepted by `POST /me/onboarding` in
`apps/api/src/auth/routes.ts`). `users.home_lat` / `home_lng` exist but no
code writes them today (§1a); if a geocoded home city is added later, it is
covered by this same declaration.

**Not collected:** Health & Fitness, Financial Info, Contacts, Photos or
Videos, Audio, Gameplay, Customer Support, Browsing History, Usage Data,
Sensitive Info, Purchases, Diagnostics (crash, performance, other), Precise
Location. The app requests no location, camera, microphone, contacts or
photos permission (`apps/web/ios/App/App/Info.plist`,
`apps/web/android/app/src/main/AndroidManifest.xml`: only `INTERNET` and
`POST_NOTIFICATIONS`).

**Open:** Health (accessibility notes), §8 open item 5; IP addresses for
security, §8 open item 3.

## 3. `PrivacyInfo.xcprivacy`: `NSPrivacyCollectedDataTypes`

The `NSPrivacyCollectedDataTypes` `<array>` of
`apps/web/ios/App/App/PrivacyInfo.xcprivacy` holds exactly these nine
entries, in this order. They match §2 and §4 one for one (Play's
"Approximate location" is Apple's Coarse Location; Play has no separate
"other data" row for the 18+ flag and currency). Keep the file, §2 and §4 in
step.

```xml
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeEmailAddress</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeName</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeEmailsOrTextMessages</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeOtherUserContent</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeSearchHistory</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeUserID</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeDeviceID</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeCoarseLocation</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
<dict>
	<key>NSPrivacyCollectedDataType</key>
	<string>NSPrivacyCollectedDataTypeOtherDataTypes</string>
	<key>NSPrivacyCollectedDataTypeLinked</key>
	<true/>
	<key>NSPrivacyCollectedDataTypeTracking</key>
	<false/>
	<key>NSPrivacyCollectedDataTypePurposes</key>
	<array>
		<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
	</array>
</dict>
```

If the owner answers yes to §8 open item 5 (health), add one more entry of
the same shape with `NSPrivacyCollectedDataTypeHealth` as the type, and
change §2 and §4 to match.

`NSPrivacyTracking` stays `false` and `NSPrivacyTrackingDomains` stays empty.
The Firebase Messaging and Capacitor SDKs ship their own privacy manifests,
which Xcode merges into the privacy report; check the generated report
(Product → Archive → Generate Privacy Report) before submitting.

## 4. Google Play Data safety

| Question                                                              | Answer                                                                                        | Why                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does your app collect or share any of the required user data types?   | Yes                                                                                           | §1                                                                                                                                                                                                                                                                                                                                                                               |
| Is all of the user data collected by your app encrypted in transit?   | Yes                                                                                           | The API is served only on `https://tagalong-api.averrow.com` (`apps/api/wrangler.jsonc`, `workers_dev: false`); the Android WebView runs on `https://localhost` (`apps/web/capacitor.config.ts`); every provider call is `https://` (`apps/api/src/providers/*.ts`)                                                                                                              |
| Do you provide a way for users to request that their data is deleted? | Yes, in the app (Account → Delete account) and at https://tagalong.averrow.com/delete-account | `apps/web/src/Account.tsx`; `apps/api/src/routes/account.ts`                                                                                                                                                                                                                                                                                                                     |
| Data shared with third parties?                                       | None                                                                                          | Every recipient in §1 is a service provider processing data for us (Play's "service provider" exemption), or a transfer the user starts themselves (sending a message to a group, opening a booking link). Ticketmaster, Duffel, Booking.com and Google Places receive search parameters with no name, email or account id. Confirm this reading with whoever handles legal (§8) |

**Data types collected** (none shared; none processed ephemerally only):

| Play category → type                        | Collected        | Required or optional                                                            | Purposes                                                                               |
| ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Personal info → Name                        | Yes              | Required (comes from sign-in); the Tagalong first name is optional              | App functionality, Account management                                                  |
| Personal info → Email address               | Yes              | Required                                                                        | App functionality, Account management                                                  |
| Personal info → User IDs                    | Yes              | Required                                                                        | App functionality, Account management, Fraud prevention, security, and compliance      |
| Messages → Other in-app messages            | Yes              | Optional (Tagalong only)                                                        | App functionality, Fraud prevention, security, and compliance (reports and moderation) |
| App activity → In-app search history        | Yes              | Required to plan                                                                | App functionality                                                                      |
| App activity → Other user-generated content | Yes              | Optional (trip description, accessibility notes, interest line, report details) | App functionality, Fraud prevention, security, and compliance (reports)                |
| Device or other IDs                         | Yes (push token) | Optional (only if notifications are allowed)                                    | App functionality                                                                      |
| Location → Approximate location             | Yes              | Required to plan (trip origin city); Tagalong and home city are optional        | App functionality                                                                      |

Price-drop emails come with saving a trip (on by default, off per trip under
My trips), so they are App functionality, not Developer communications
(`migrations/0004_saved_trips_shares_alerts.sql` `alerts_enabled DEFAULT 1`;
`apps/api/src/routes/trips.ts`; `apps/api/src/planning/alerts.ts`).

Approximate location covers the typed or picked cities listed in §2 (owner
decision, §8); the app never reads device location and the Android manifest
has no location permission.

**Not collected:** Financial info, Health and fitness (pending §8 open item
5), Precise location, Contacts, Photos and videos, Audio, Files and docs,
Calendar, Web browsing history, App interactions, Installed apps, Crash logs,
Diagnostics, Other app performance data. IP addresses: §8 open item 3.

## 5. Listing copy

The app is called **Budgetrip**: `appName: "Budgetrip"` in
`apps/web/capacitor.config.ts` (the home-screen label), and the web manifest
calls it "Budgetrip by Tagalong" with short name "Budgetrip"
(`apps/web/public/manifest.webmanifest`). Tagalong is its social layer.

| Field                        | App Store                                                                                                      | Google Play                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| App name                     | Budgetrip by Tagalong (21 of 30)                                                                               | Budgetrip by Tagalong (21 of 30)                                                            |
| Subtitle / short description | Event trips that fit a budget (29 of 30)                                                                       | Plan a trip to any event within your budget, with real prices and links to book. (80 of 80) |
| Primary category             | Travel                                                                                                         | Travel & Local                                                                              |
| Secondary category           | Entertainment                                                                                                  | n/a                                                                                         |
| Keywords (App Store only)    | `event,trip,planner,budget,concert,festival,game,tickets,hotel,flight,weekend,travel,meetup,group` (96 of 100) | n/a                                                                                         |
| Support URL                  | https://tagalong.averrow.com/support                                                                           | Website: https://tagalong.averrow.com/support                                               |
| Privacy policy URL           | https://tagalong.averrow.com/privacy                                                                           | https://tagalong.averrow.com/privacy                                                        |
| Terms (EULA)                 | https://tagalong.averrow.com/terms                                                                             | https://tagalong.averrow.com/terms                                                          |
| Account deletion URL         | n/a (in-app)                                                                                                   | https://tagalong.averrow.com/delete-account                                                 |
| Contact email                | support@averrow.com                                                                                            | support@averrow.com                                                                         |
| Devices                      | iPhone only (`TARGETED_DEVICE_FAMILY = 1` in `apps/web/ios/App/App.xcodeproj/project.pbxproj`)                 | Phones                                                                                      |
| Screenshots                  | 6.9" iPhone display only; no iPad screenshots (the app does not run as an iPad app)                            | Phone screenshots                                                                           |

**Full description** (both stores):

```text
Pick an event, set a budget, and Budgetrip finds five different ways to get there.

Tell Budgetrip where you're starting from, the game, concert, festival, convention or meetup you want to see, your budget and what you like. Write it in your own words or fill in the form. Either way, you check every detail before anything is planned.

FIVE TRIPS, ALL UNDER BUDGET
You get up to five packages: tickets, getting there, a place to stay and things to do. Cheapest, best value, best experience, a weekend version and an alternative. Anything over your budget is left out.

PRICES YOU CAN CHECK
Ticket, flight and hotel prices come from the providers themselves, and each one shows when it was fetched. Where there's no live price, Budgetrip shows an estimate, labels it clearly and says how it worked the number out. Hit re-check for fresh prices any time.

BOOK WITH THE SELLER
Budgetrip doesn't sell tickets, flights or hotels. Every item links to the real seller, where you see the final price and book.

SAVE, SHARE, GET ALERTS
Save a trip and Budgetrip keeps checking it. If the price drops, you get an email or a notification. Share a read-only link with the people you're going with.

TAGALONG: MEET OTHER FANS GOING
Turn on Tagalong to see who else is going to the same event, join the event's group chat, and plan together.
- Opt in only, and 18+.
- Others see only the first name and city you choose. Never your exact location or email.
- Direct messages open only after you both agree to connect.
- Block and report on every message and profile. Reports go to a moderation queue.
- A safety note before your first connection: meet in public places.

Any event, from any city. Delete your account and its data from the app at any time.
```

The copy describes features the code has: the confirm-before-plan step
(`apps/web/src/Planner.tsx`), five labelled packages and the budget filter
(`packages/shared/src/ranking.ts`), "as of" times and estimate labels
(`apps/web/src/PlanView.tsx`), link-out only (`docs/BUILD_SPEC.md` §2.2),
re-check (`apps/api/src/routes/plans.ts`), alerts
(`apps/api/src/planning/alerts.ts`), share links
(`apps/api/src/routes/trips.ts`) and Tagalong's rules (`docs/BUILD_SPEC.md`
§6, `apps/api/src/tagalong/`). It never says the AI finds, sets or estimates
a price: the AI only reads the user's description into form fields
(`apps/api/src/providers/anthropic.ts`).

## 6. Age rating

| Question                                                                             | Answer           | Why                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| User-generated content                                                               | Yes              | Group chat, DMs, Tagalong names, interest lines (`apps/api/src/tagalong/messages.ts`)                                                            |
| Users can communicate with each other (messaging and chat)                           | Yes              | Group chat and DMs after a mutual connect (`apps/api/src/routes/groups.ts`, `apps/api/src/routes/social.ts`)                                     |
| Content controls                                                                     | Yes              | Block, report, moderation queue, rate limits and stricter limits for new accounts (`apps/api/src/tagalong/blocks.ts`, `reports.ts`, `limits.ts`) |
| Users share location with each other                                                 | No               | City name only, chosen by the user (`packages/shared/src/tagalong.ts`, `TagalongCitySchema`)                                                     |
| Unrestricted web access                                                              | No               | The app opens specific seller links; it has no browser with an address bar (`apps/web/src/PlanView.tsx`)                                         |
| Advertising                                                                          | No               | No ad SDK (§2)                                                                                                                                   |
| Gambling, contests, simulated gambling                                               | No               |                                                                                                                                                  |
| Violence, sexual content, profanity, drugs, horror, mature themes (by the developer) | None             |                                                                                                                                                  |
| Medical or treatment information                                                     | No               |                                                                                                                                                  |
| Purchases, loot boxes                                                                | No               | No in-app purchases; nothing is sold in the app                                                                                                  |
| Age assurance                                                                        | Self-declaration | 18+ confirmed at sign-up; required before planning and Tagalong (`apps/api/src/auth/session.ts`, `requireAdult`)                                 |
| **Rating to choose**                                                                 | **18+**          | App Store: 18+. Google Play (IARC): answer as above and set the target age group to 18 and over                                                  |

Rating it 18+ matches the in-app gate (spec §2.5, §6). The questionnaire
alone may calculate a lower rating; App Store Connect lets you choose a
higher one, so choose 18+. On Google Play, set the target audience to 18+
only.

## 7. App Review notes

Paste into App Store Connect → App Review Information → Notes (and Play's
app access instructions):

```text
Signing in
Tap "Sign in with Apple" (or "Sign in with Google") on the first screen. Any Apple ID works; a new account is created on first sign-in. After signing in, confirm you are 18 or older and pick a currency.

Planning (Budgetrip)
Type a trip such as "From Toronto to see the Knicks at Madison Square Garden in March, $1,200 CAD for two" and tap "Fill in the form for me", or fill in the form yourself. Check the fields and tap Plan. Prices come from provider APIs (Ticketmaster, Duffel, Booking.com) and show an "as of" time; anything without a live price is labelled "estimate" with how it was worked out. The AI only turns the typed description into form fields; it never produces a price.

Budgetrip links out and does not sell
The app sells nothing and takes no payments. Each ticket, flight or hotel links to the seller's own website, where the user books. There are no in-app purchases.

Tagalong (optional social features, 18+)
Open a plan and tap "Who else is going?", then "Join Tagalong". Choose a first name and a city name (only those are shown to others). You can then join the event's group chat. Direct messages need both people to accept a connection, after a "meet in public places" safety note.

Safety: block, report, moderation
Every message and profile has Report and Block. Blocking hides both people from each other everywhere. Reports go to a moderation queue, where our moderators can dismiss a report, remove a message or suspend a user from Tagalong. New accounts have lower limits on joining groups, messaging and connecting.

Account deletion
Account (top navigation) → "Delete account" → type DELETE → "Delete my account" → confirm. This deletes the account and its data immediately and signs out everywhere. Also described at https://tagalong.averrow.com/delete-account.

Contact: support@averrow.com
```

The steps match `apps/web/src/App.tsx` (sign-in buttons, Account link),
`apps/web/src/WhoElse.tsx` and `TagalongGate.tsx` (Who else is going? / Join
Tagalong), `apps/web/src/SafetyActions.tsx` (Report, Block),
`apps/web/src/Connections.tsx` (safety note), `apps/web/src/Account.tsx`
(Delete account) and `apps/api/src/routes/moderation.ts`.

Before submitting: Sign in with Apple must be configured (`docs/SETUP.md`
§1g), or the reviewer's sign-in fails with "misconfigured". Without Duffel
and Booking.com keys, flights and hotels show as labelled estimates
(`docs/SETUP.md` §1b). A reviewer alone sees an empty group chat; see §8
open item 7.

## 8. Owner decisions

### Decided

- **Contact:** support@averrow.com, for support and privacy, in both stores,
  the review notes (§7) and on /support and /privacy.
- **Devices:** iPhone only. `TARGETED_DEVICE_FAMILY = 1`
  (`apps/web/ios/App/App.xcodeproj/project.pbxproj`), so App Store Connect
  needs 6.9" iPhone screenshots and no iPad ones (§5).
- **Typed cities are approximate location.** A city the user types or picks
  and that is stored on the account is declared as Coarse Location (Apple)
  and Approximate location (Play): collected, linked to the user, for app
  functionality, not tracking (§2, §3, §4). The app never reads device
  location.

### Open

Items 1 and 2 must be done before submitting. Items 3 to 9 are also still
open: the code's current behaviour is stated, and the answer is yours.

1. **Controller.** Fill `{{CONTROLLER}}` (the legal entity responsible for
   the data, and its country), which the privacy policy and Play's developer
   details need.
2. **Legal review of /privacy and /terms** before submitting to either store,
   including the readings this file relies on (Play's service-provider
   exemption in §4, the retention choices below).
3. **Declare security-only IP use?** IP addresses are stored only as
   rate-limit keys, for abuse prevention, kept at most 24 hours (in practice
   at most 7), not linked to an account (§1e). Cloudflare's own logs also see them. Decide whether the
   privacy labels declare this (and under which type), or whether the privacy
   policy alone covers it.
4. **Retention of tombstones, reports and suspended identities.** Currently
   kept **indefinitely**, with no pruning: the `users` tombstone (id,
   created/deleted dates, suspension date), every report (by and against a
   deleted user, with any details text), the text of reported messages,
   closed `connections` rows, and `suspended_identities` hashes. Decide
   whether to set limits (for example, delete resolved reports after N
   months) and state them in the privacy policy.
5. **Accessibility notes as health data?** The planner has an optional free
   text field for accessibility needs (up to 500 characters, stored in
   `trip_requests.prefs_json`, never shown on share links). Decide whether to
   declare it as Health (Apple) / Health info (Play) or keep it under other
   user content.
6. **Third-party AI disclosure.** The free-text description goes to Anthropic
   (§1b), and the planner screen does not say so (`apps/web/src/Planner.tsx`
   only says "Describe it in your own words"). App Review guideline 5.1.2(i)
   asks apps to disclose sharing personal data with third-party AI and get
   permission first. Decide on the wording (a line under the box is enough
   for the form-only path, which never calls the AI) and have it added to
   the planner screen and the privacy policy.
7. **Review account, demo content and moderators.** Decide whether to give
   reviewers a prepared account or group with a second member, so they can
   see chat, block and report without a second device. Also set
   `MODERATOR_USER_IDS` in `apps/api/wrangler.jsonc` before launch: it is
   empty, so today nobody can open the moderation queue (reports are
   recorded and wait), which App Review expects to be staffed for apps with
   user-generated content (`docs/SETUP.md` §1e).
8. **Data kept outside the deletion path.** User-described events (the typed
   event name, city and date) live in the shared `events` table and are not
   removed by account deletion (§1b). Opting out of Tagalong keeps the chosen
   name and city, and deleting your own message keeps its text (§1d). Decide
   whether that is acceptable as is (and say so in the privacy policy) or
   should change.
9. **Workers Logs retention.** Logging is on for every request
   (`apps/api/wrangler.jsonc`). How long Cloudflare keeps the logs depends on
   the account's plan (see Cloudflare's Workers Logs documentation). State
   that period in the privacy policy, or lower `head_sampling_rate`.
