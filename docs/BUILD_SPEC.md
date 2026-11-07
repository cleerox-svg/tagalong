# Budgetrip + Tagalong — Build Spec

This file is the source of truth for the `cleerox-svg/tagalong` repo. Read it
before changing anything. Build **one phase (§9) per session**, then stop.

---

## 1. What we're building

One platform, two products:

| Product | What it does |
|---|---|
| **Budgetrip** | The planner. A user says where they're starting from, what event they want to go to, their budget and what they like. Budgetrip finds the event and returns **5 ranked trip packages** (tickets + travel + stay + things to do) that fit the budget. |
| **Tagalong** | The social layer. Users who are going to the same event (or are in the same city that weekend) can find each other, join an event group, and plan together. |

**Any event, from anywhere.** Sports, concerts, festivals, import/car shows,
gaming events, conventions, meetups, social events. The user can start from any
city in the world. No region is hard-coded.

Example: *"I'm in Toronto, I want to see the Knicks at MSG in March, $1,200 CAD
for two of us, we'd rather drive, we like food and nightlife."*
→ Five packages, e.g. cheapest, best value, best seats, make-a-weekend-of-it,
no-car option. Each one shows its total price, what's in it and links to book.

## 2. Principles (easy to break by accident)

1. **Prices come from APIs, never from the AI.** Claude reads the request and
   writes the itinerary text. Every dollar figure comes from a provider
   response, is stored with its source and `fetched_at`, and is shown with an
   "as of" time. If there's no price, the app says "estimate" and shows how it
   got the number. It never makes one up.
2. **Budgetrip links out, it doesn't sell.** We don't take payment for tickets,
   flights or hotels. Each item has a link to the real seller (affiliate where
   available). This keeps us out of acting as a travel seller. Selling travel
   needs a licence in some places, e.g. TICO registration in Ontario, so get
   that checked before we ever take payment.
3. **Money is stored in minor units with a currency.** `amount_minor INTEGER` +
   `currency TEXT` (ISO 4217). Convert to the user's home currency for display
   using a stored rate with its date. Never use floats for money.
4. **The ranking is deterministic code.** The AI can explain a package, but the
   budget filter and the ranking happen in code, in
   `packages/shared/src/ranking.ts`, and they have tests.
5. **Tagalong is safety-first.** Opt-in only, 18+, nobody's exact location is
   ever shown, block and report on every surface, group chats come before DMs.
   See §6.
6. **Migrations are append-only.** Never edit a migration that has been merged.
   Add a new numbered file.
7. **Secrets go through `wrangler secret put`.** They never go in
   `wrangler.jsonc`, the client bundle or a `VITE_` variable.

## 3. Architecture

Uses the same setup as BVOM, which already works:

- **API:** Cloudflare Worker at `https://tagalong-api.averrow.com` (already
  live, with D1 migrated, CI on every PR and auto-deploy on merge).
- **Web:** Vite + React PWA at `https://tagalong.averrow.com` (phase 1).
- **Data:** D1 (relational), KV (sessions, provider response cache), Queues (a
  planning run fans out to the providers).
- **Real-time chat (phase 5):** Durable Objects, one per event group.
- **AI:** Anthropic API, server-side only, used to parse requests and write
  itineraries.
- **Monorepo:** `apps/api`, `apps/web`, `packages/shared` (types, money,
  ranking), pnpm workspace.

### Planning pipeline

```
request ──► parse (Claude → typed TripRequest, user confirms)
        ──► resolve event (event providers)
        ──► gather in parallel: tickets │ transport │ lodging │ activities
        ──► assemble candidate packages (code)
        ──► filter by budget + rank by preferences (code)
        ──► top 5 + itinerary write-up (Claude, gets only stored facts)
        ──► save plan + price snapshots
```

A planning run is asynchronous. The client polls `GET /plans/:id`, or streams
it, and shows progress ("finding hotels…").

## 4. Data model (first pass)

```
users            id, email, display_name, home_city, home_lat, home_lng,
                 home_currency, birthdate_verified_18 (bool), created_at
trip_requests    id, user_id, raw_text, origin_city, origin_lat, origin_lng,
                 event_query, date_from, date_to, party_size,
                 budget_minor, budget_currency, budget_scope ('total'|'per_person'),
                 prefs_json, created_at
events           id, provider, provider_event_id, name, category,
                 venue_name, city, country, lat, lng, starts_at, url,
                 UNIQUE(provider, provider_event_id)
plans            id, trip_request_id, event_id, status, created_at
packages         id, plan_id, rank, label ('cheapest'|'best_value'|...),
                 total_minor, currency, score, summary_text
package_items    id, package_id, kind ('ticket'|'transport'|'lodging'|'activity'|'food'),
                 title, provider, provider_ref, amount_minor, currency,
                 is_estimate (bool), booking_url, fetched_at, details_json
fx_rates         base, quote, rate, as_of, PRIMARY KEY(base, quote, as_of)
saved_trips      user_id, plan_id, created_at
-- Tagalong (phase 5)
event_groups     id, event_id, created_at
group_members    group_id, user_id, joined_at, role
messages         id, group_id, user_id, body, created_at, deleted_at
blocks           blocker_id, blocked_id, created_at
reports          id, reporter_id, target_type, target_id, reason, created_at, resolved_at
```

## 5. Budgetrip: inputs, packages, ranking

**Inputs**
- **Origin:** a free-text city, geocoded. If it's ambiguous ("London"), ask.
- **Event:** a name, team/artist, a category + city + dates, or a pasted event
  URL.
- **Dates:** fixed or flexible.
- **Party size.** **Budget:** amount + currency + total or per person.
- **Preferences:** how they travel (drive / fly / train / bus / any), where
  they stay (hotel / rental / hostel / any), max nights, seat quality, vibe
  tags (food, nightlife, sightseeing, outdoors, family, budget-max), and
  accessibility needs.

Claude turns free text into a `TripRequest`. The user **sees and confirms**
the parsed fields before the run starts.

**Packages.** We build candidate combinations, then pick 5 that are *different
from each other*, not five near-copies:

| Label | Idea |
|---|---|
| Cheapest | Lowest total that still gets you in the door |
| Best value | Highest score per dollar |
| Best experience | Best seats / stay inside budget |
| Make a weekend of it | Extra night + more activities |
| Alternative | Different transport or a different date/game, if one exists |

**Ranking** (`packages/shared/src/ranking.ts`)
- Hard filter: `total ≤ budget` (with the budget turned into a total first
  when it's per person). Over-budget packages are never shown.
- Score = weighted preference match (transport, stay type, seat tier, vibe
  tags, travel time, distance from the stay to the venue). The weights live in
  one place and have tests.
- **Travel across borders:** convert currencies, add "passport needed" to
  international trips, and include border/customs time in drive estimates.

**Costs the app has to include** (otherwise "under budget" is a lie):
ticket fees, hotel taxes, gas + tolls + parking for drives, airport transfers,
and a food allowance per person per day (an estimate, labelled as one).

## 6. Tagalong: the social layer

**What it does (phase 5)**
- On any event page or saved trip: "Who else is going?" → join that event's
  **group** (opt-in).
- The group shows members' display name, their home *city* (never anything
  finer) and what they're interested in (e.g. "looking for pre-game food").
- Group chat. **DMs only once both people have opted in to each other** (a
  mutual "connect").
- Later: "split a rental / share a ride" posts inside a group.

**Safety rules (not optional)**
- 18+ only, confirmed at sign-up.
- Nobody's exact location is ever shown or stored beyond city level for
  Tagalong.
- Block (hides both ways, everywhere) and report on every message, profile and
  post.
- Rate limits on joining groups and sending messages. New accounts are limited
  until they're trusted.
- A moderation queue for reports. Messages are soft-deleted so reports can
  still be reviewed.
- A "meet in public places" safety note before anyone's first connect.

## 7. Providers

| Need | First choice | Also |
|---|---|---|
| Ticketed events (sports, concerts) | Ticketmaster Discovery API | SeatGeek |
| Community / niche events | Eventbrite | Pasted URL → page parse |
| Flights | Duffel or Amadeus Self-Service | Affiliate deep links |
| Hotels / rentals | Booking.com or Expedia affiliate | Hostelworld |
| Driving time / cost | Google Routes | — |
| Places, food, activities | Google Places | — |
| Geocoding | Google Geocoding | — |
| Currency | A daily FX rate feed | — |

Every provider sits behind an adapter in `apps/api/src/providers/<name>.ts`
that returns our own types, so swapping a provider doesn't touch the
pipeline. Responses are cached in KV with a TTL that fits each provider (prices
for a short time, venue data for longer).

Facebook/Instagram events have no public API. Users can paste the link and we
plan from what we can read, with a fallback to "tell us the date and city".

Eventbrite retired its public event search API in 2020, so Eventbrite events
come in by pasted link (`GET /v3/events/:id`, or the page's schema.org data
without a token). Category browse uses Ticketmaster Discovery. A pasted page
is read only from its schema.org Event JSON-LD, not by the AI, so any price on
it is the page's own figure with the page named as its source.

## 8. Security

- Google sign-in, an HttpOnly signed session cookie (same pattern as BVOM).
- Every query is scoped by `user_id`. A test checks that one user can't read
  another user's plans, saved trips or groups they aren't in.
- CORS: an explicit allowlist (`https://tagalong.averrow.com`,
  `http://localhost:5173`). No wildcards.
- Provider keys and `ANTHROPIC_API_KEY` are Worker secrets. CI greps the built
  bundle for them.
- What the user types is data, not instructions, when it's sent to Claude.
  The parse step returns a schema-validated object only.

## 9. Phases

| # | Phase | Done when |
|---|---|---|
| 0 | **Foundation** (mostly done) | Worker live, D1, CI, auto-deploy. Add the monorepo layout, shared money/types package, web app shell. |
| 1 | **Budgetrip MVP** | Sign in → enter a request (form + free text) → Ticketmaster event lookup → transport/lodging as labelled *estimates* → 5 ranked packages under budget. Works from any origin city. |
| 2 | **Live prices** | Real hotel and flight prices with booking links, FX conversion, "as of" times, a re-check price button. |
| 3 | **Accounts & saved trips** | Save a plan, share a read-only link, price-drop alert by email. |
| 4 | **Any event** | Eventbrite + pasted URL planning, category browse ("gaming events near X in May"). |
| 5 | **Tagalong** | Event groups, group chat (Durable Objects), mutual connect + DMs, block/report, moderation queue. |
| 6 | **Mobile** | iOS/Android app (Capacitor), push notifications. |

## 10. Open decisions

1. Which flight/hotel provider to sign up with first (each has its own
   approval process and terms).
2. Affiliate programs to apply for, and when to start earning money.
3. Whether to check age with a self-declaration only, or with something
   stronger, before Tagalong launches.
4. A legal check of the "links out, doesn't sell" position before taking any
   payment.
