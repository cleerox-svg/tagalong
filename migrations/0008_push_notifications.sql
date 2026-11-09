-- 0008_push_notifications: phase 6 (docs/BUILD_SPEC.md §9): the Capacitor
-- app, push notifications and native sign-in.
--
-- APPEND-ONLY: never edit this file once merged; add 0009_*.sql instead.
--
-- push_devices: one row per device push token (APNs/FCM). A token belongs to
--   one user at a time (UNIQUE); re-registering moves it. disabled_at is set
--   when the provider reports the token dead or the user signs out on that
--   device; last_error keeps the provider's last failure for diagnosis.
-- notification_prefs: per-user opt-outs by kind. No row means the defaults
--   below. Group chat is off by default (it can be noisy); the rest are on.
-- push_throttle: last push sent per user per room (a group or a DM), so a busy
--   chat sends one notification per window, not one per message.
-- native_auth_codes: one-time codes that hand a web Google sign-in back to the
--   app (PKCE). Only the SHA-256 of the code is stored, never the code itself;
--   code_challenge is the app's S256 challenge. used_at makes a code single-use.
-- price_alerts.pushed_at / push_error: the push counterpart of
--   emailed_at / email_error, so a failed push is visible.

CREATE TABLE IF NOT EXISTS push_devices (
	id           TEXT PRIMARY KEY,
	user_id      TEXT NOT NULL REFERENCES users(id),
	platform     TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
	token        TEXT NOT NULL UNIQUE,
	created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	disabled_at  TEXT,
	last_error   TEXT
);
CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices (user_id, disabled_at);

CREATE TABLE IF NOT EXISTS notification_prefs (
	user_id             TEXT PRIMARY KEY REFERENCES users(id),
	dm                  INTEGER NOT NULL DEFAULT 1 CHECK (dm IN (0, 1)),
	group_message       INTEGER NOT NULL DEFAULT 0 CHECK (group_message IN (0, 1)),
	connection_request  INTEGER NOT NULL DEFAULT 1 CHECK (connection_request IN (0, 1)),
	connection_accepted INTEGER NOT NULL DEFAULT 1 CHECK (connection_accepted IN (0, 1)),
	price_drop          INTEGER NOT NULL DEFAULT 1 CHECK (price_drop IN (0, 1)),
	updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS push_throttle (
	user_id      TEXT NOT NULL REFERENCES users(id),
	room_key     TEXT NOT NULL,
	last_sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (user_id, room_key)
);

CREATE TABLE IF NOT EXISTS native_auth_codes (
	code_hash      TEXT PRIMARY KEY,
	user_id        TEXT NOT NULL REFERENCES users(id),
	code_challenge TEXT NOT NULL,
	expires_at     TEXT NOT NULL,
	used_at        TEXT,
	created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS native_auth_codes_expiry ON native_auth_codes (expires_at);

ALTER TABLE price_alerts ADD COLUMN pushed_at TEXT;
ALTER TABLE price_alerts ADD COLUMN push_error TEXT;
