-- 0004_saved_trips_shares_alerts: phase 3 (docs/BUILD_SPEC.md §9).
--
-- APPEND-ONLY: never edit this file once merged; add 0005_*.sql instead.
--
-- saved_trips: one row per user per trip request. plan_id is the plan the
--   user saved; latest_plan_id follows re-checks (manual or scheduled) so
--   "My trips" always shows the newest prices. best_total_minor is the lowest
--   cheapest-package total seen, in currency, which price-drop alerts compare
--   against.
-- share_links: an unguessable token that shows one plan read-only, without
--   signing in. Revoking sets revoked_at; the row is kept.
-- price_alerts: every drop the scheduled re-check found, whether or not the
--   email went out, so the app can show it and a failed send is visible.

CREATE TABLE IF NOT EXISTS saved_trips (
	user_id          TEXT NOT NULL REFERENCES users(id),
	plan_id          TEXT NOT NULL REFERENCES plans(id),
	trip_request_id  TEXT NOT NULL REFERENCES trip_requests(id),
	latest_plan_id   TEXT NOT NULL REFERENCES plans(id),
	alerts_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (alerts_enabled IN (0, 1)),
	best_total_minor INTEGER,
	currency         TEXT NOT NULL,
	last_checked_at  TEXT,
	created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (user_id, trip_request_id)
);
CREATE INDEX IF NOT EXISTS saved_trips_due ON saved_trips (alerts_enabled, last_checked_at);

CREATE TABLE IF NOT EXISTS share_links (
	token      TEXT PRIMARY KEY,
	plan_id    TEXT NOT NULL REFERENCES plans(id),
	user_id    TEXT NOT NULL REFERENCES users(id),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS share_links_plan ON share_links (plan_id, user_id);

CREATE TABLE IF NOT EXISTS price_alerts (
	id               TEXT PRIMARY KEY,
	user_id          TEXT NOT NULL REFERENCES users(id),
	trip_request_id  TEXT NOT NULL REFERENCES trip_requests(id),
	plan_id          TEXT NOT NULL REFERENCES plans(id),
	old_total_minor  INTEGER NOT NULL,
	new_total_minor  INTEGER NOT NULL,
	currency         TEXT NOT NULL,
	created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	emailed_at       TEXT,
	email_error      TEXT
);
CREATE INDEX IF NOT EXISTS price_alerts_user ON price_alerts (user_id, created_at);
