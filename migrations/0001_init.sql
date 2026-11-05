-- 0001_init: groundwork only. The product schema arrives with the plan.
--
-- Migrations are APPEND-ONLY: never edit, rename or delete this file once it is
-- merged. Add 0002_*.sql instead. CI enforces this
-- (scripts/check-migrations-immutable.sh).

CREATE TABLE IF NOT EXISTS app_meta (
	key        TEXT PRIMARY KEY,
	value      TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO app_meta (key, value) VALUES ('schema_origin', '0001_init')
	ON CONFLICT(key) DO NOTHING;
