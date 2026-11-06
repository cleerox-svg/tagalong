-- 0002_budgetrip: phase 1 schema (docs/BUILD_SPEC.md §4, §9).
--
-- APPEND-ONLY: never edit this file once merged; add 0003_*.sql instead.
--
-- Money is INTEGER minor units + an ISO 4217 TEXT currency. Never REAL.
-- Timestamps are ISO-8601 UTC TEXT.
--
-- Differences from the spec's "first pass" model, all additive:
--   users.google_sub   - the stable Google account id we sign in with
--   users.age_confirmed_at - when the 18+ self-declaration was made (open decision §10.3)
--   trip_requests.origin_country, event_city, event_pinned_id - needed to plan; city-level only
--   plans.user_id      - denormalised so every plan query is scoped by user_id directly
--   plans.progress, error, result_json - async run status and the ranking summary
--   events.local_date, price_* - the provider's listed face-value range and when it was fetched
--   package_items.method - how an estimate was reached (spec §2.1)
--   fx_rates.fetched_at, source
--   rate_limits        - per-user request counters

CREATE TABLE IF NOT EXISTS users (
	id                    TEXT PRIMARY KEY,
	google_sub            TEXT NOT NULL UNIQUE,
	email                 TEXT NOT NULL,
	display_name          TEXT NOT NULL,
	home_city             TEXT,
	home_lat              REAL,
	home_lng              REAL,
	home_currency         TEXT,
	birthdate_verified_18 INTEGER NOT NULL DEFAULT 0 CHECK (birthdate_verified_18 IN (0, 1)),
	age_confirmed_at      TEXT,
	created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS trip_requests (
	id              TEXT PRIMARY KEY,
	user_id         TEXT NOT NULL REFERENCES users(id),
	raw_text        TEXT,
	origin_city     TEXT NOT NULL,
	origin_lat      REAL NOT NULL,
	origin_lng      REAL NOT NULL,
	origin_country  TEXT NOT NULL,
	event_query     TEXT NOT NULL,
	event_city      TEXT,
	-- A pinned Ticketmaster event id ("plan this date instead"), else NULL.
	event_pinned_id TEXT,
	date_from       TEXT NOT NULL,
	date_to         TEXT NOT NULL,
	party_size      INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 20),
	budget_minor    INTEGER NOT NULL CHECK (budget_minor > 0),
	budget_currency TEXT NOT NULL,
	budget_scope    TEXT NOT NULL CHECK (budget_scope IN ('total', 'per_person')),
	prefs_json      TEXT NOT NULL,
	created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS trip_requests_user ON trip_requests (user_id, created_at);

CREATE TABLE IF NOT EXISTS events (
	id                TEXT PRIMARY KEY,
	provider          TEXT NOT NULL,
	provider_event_id TEXT NOT NULL,
	name              TEXT NOT NULL,
	category          TEXT,
	venue_name        TEXT,
	city              TEXT,
	country           TEXT,
	lat               REAL,
	lng               REAL,
	local_date        TEXT,
	starts_at         TEXT,
	url               TEXT,
	price_min_minor   INTEGER,
	price_max_minor   INTEGER,
	price_currency    TEXT,
	fetched_at        TEXT NOT NULL,
	UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS plans (
	id              TEXT PRIMARY KEY,
	user_id         TEXT NOT NULL REFERENCES users(id),
	trip_request_id TEXT NOT NULL REFERENCES trip_requests(id),
	event_id        TEXT REFERENCES events(id),
	status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
	progress        TEXT,
	error           TEXT,
	result_json     TEXT,
	created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS plans_user ON plans (user_id, created_at);

CREATE TABLE IF NOT EXISTS packages (
	id           TEXT PRIMARY KEY,
	plan_id      TEXT NOT NULL REFERENCES plans(id),
	rank         INTEGER NOT NULL,
	label        TEXT NOT NULL CHECK (label IN ('cheapest', 'best_value', 'best_experience', 'weekend', 'alternative')),
	event_id     TEXT NOT NULL REFERENCES events(id),
	total_minor  INTEGER NOT NULL,
	currency     TEXT NOT NULL,
	score        REAL NOT NULL,
	summary_text TEXT NOT NULL,
	details_json TEXT NOT NULL,
	UNIQUE (plan_id, rank)
);

CREATE TABLE IF NOT EXISTS package_items (
	id           TEXT PRIMARY KEY,
	package_id   TEXT NOT NULL REFERENCES packages(id),
	position     INTEGER NOT NULL,
	kind         TEXT NOT NULL CHECK (kind IN ('ticket', 'transport', 'lodging', 'activity', 'food')),
	title        TEXT NOT NULL,
	provider     TEXT NOT NULL,
	provider_ref TEXT,
	amount_minor INTEGER NOT NULL,
	currency     TEXT NOT NULL,
	is_estimate  INTEGER NOT NULL CHECK (is_estimate IN (0, 1)),
	booking_url  TEXT,
	fetched_at   TEXT NOT NULL,
	method       TEXT NOT NULL,
	details_json TEXT
);
CREATE INDEX IF NOT EXISTS package_items_package ON package_items (package_id, position);

CREATE TABLE IF NOT EXISTS fx_rates (
	base       TEXT NOT NULL,
	quote      TEXT NOT NULL,
	rate       REAL NOT NULL CHECK (rate > 0),
	as_of      TEXT NOT NULL,
	source     TEXT NOT NULL,
	fetched_at TEXT NOT NULL,
	PRIMARY KEY (base, quote, as_of)
);

CREATE TABLE IF NOT EXISTS rate_limits (
	key          TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	count        INTEGER NOT NULL,
	PRIMARY KEY (key, window_start)
);
