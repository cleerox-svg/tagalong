-- 0006_tagalong: phase 5 (docs/BUILD_SPEC.md §9): Tagalong groups, chat,
-- connections, blocks, reports and moderation.
--
-- APPEND-ONLY: never edit this file once merged; add 0007_*.sql instead.
--
-- users.tagalong_*: opt-in state. tagalong_name and tagalong_city are what
--   other members see; they are chosen at opt-in and are never the Google
--   name, the email, or anything derived from home_lat/home_lng.
--   tagalong_trusted_at is set by a moderator; otherwise an account counts as
--   trusted once created_at is 7 days old. tagalong_suspended_at removes
--   Tagalong access.
-- event_groups: exactly one group per event.
-- group_members: who is in a group, with an optional short interest line.
-- connections: one row per pair of users, stored with user_lo < user_hi so the
--   pair is unique whichever side asked. requested_by is the asker.
-- messages: the only message store (the ChatRoom Durable Object only fans out).
--   A message belongs to exactly one of a group or an accepted connection (DM).
--   Deletion is soft: deleted_at/deleted_by, the body is kept for moderation.
-- blocks: one direction per row; the app hides both ways.
-- reports: one per reporter per target. target_id is polymorphic (message,
--   user, or a future 'post'), so it has no foreign key.

ALTER TABLE users ADD COLUMN tagalong_opt_in_at TEXT;
ALTER TABLE users ADD COLUMN tagalong_name TEXT;
ALTER TABLE users ADD COLUMN tagalong_city TEXT;
ALTER TABLE users ADD COLUMN tagalong_safety_ack_at TEXT;
ALTER TABLE users ADD COLUMN tagalong_trusted_at TEXT;
ALTER TABLE users ADD COLUMN tagalong_suspended_at TEXT;

CREATE TABLE IF NOT EXISTS event_groups (
	id         TEXT PRIMARY KEY,
	event_id   TEXT NOT NULL UNIQUE REFERENCES events(id),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS group_members (
	group_id  TEXT NOT NULL REFERENCES event_groups(id),
	user_id   TEXT NOT NULL REFERENCES users(id),
	role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member')),
	interest  TEXT CHECK (interest IS NULL OR length(interest) <= 140),
	joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members (user_id);

CREATE TABLE IF NOT EXISTS connections (
	id           TEXT PRIMARY KEY,
	user_lo      TEXT NOT NULL REFERENCES users(id),
	user_hi      TEXT NOT NULL REFERENCES users(id),
	requested_by TEXT NOT NULL REFERENCES users(id),
	status       TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'accepted', 'declined', 'closed')),
	created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	responded_at TEXT,
	CHECK (user_lo < user_hi),
	CHECK (requested_by IN (user_lo, user_hi)),
	UNIQUE (user_lo, user_hi)
);
CREATE INDEX IF NOT EXISTS connections_hi ON connections (user_hi);

CREATE TABLE IF NOT EXISTS messages (
	id            TEXT PRIMARY KEY,
	group_id      TEXT REFERENCES event_groups(id),
	connection_id TEXT REFERENCES connections(id),
	user_id       TEXT NOT NULL REFERENCES users(id),
	body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
	created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	deleted_at    TEXT,
	deleted_by    TEXT CHECK (deleted_by IS NULL OR deleted_by IN ('author', 'moderator')),
	CHECK ((group_id IS NULL) <> (connection_id IS NULL))
);
CREATE INDEX IF NOT EXISTS messages_group ON messages (group_id, created_at);
CREATE INDEX IF NOT EXISTS messages_conn ON messages (connection_id, created_at);

CREATE TABLE IF NOT EXISTS blocks (
	blocker_id TEXT NOT NULL REFERENCES users(id),
	blocked_id TEXT NOT NULL REFERENCES users(id),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (blocker_id, blocked_id),
	CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks (blocked_id);

CREATE TABLE IF NOT EXISTS reports (
	id          TEXT PRIMARY KEY,
	reporter_id TEXT NOT NULL REFERENCES users(id),
	target_type TEXT NOT NULL CHECK (target_type IN ('message', 'user', 'post')),
	target_id   TEXT NOT NULL,
	reason      TEXT NOT NULL
		CHECK (reason IN ('spam', 'harassment', 'safety', 'inappropriate', 'other')),
	details     TEXT CHECK (details IS NULL OR length(details) <= 1000),
	created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	resolved_at TEXT,
	resolved_by TEXT REFERENCES users(id),
	resolution  TEXT
		CHECK (resolution IS NULL OR resolution IN ('dismissed', 'message_removed', 'user_suspended')),
	UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS reports_open ON reports (resolved_at, created_at);
