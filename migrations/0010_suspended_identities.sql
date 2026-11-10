-- 0010_suspended_identities: phase 7 follow-up. Deleting a suspended account
-- and signing up again must not lift a Tagalong suspension.
--
-- APPEND-ONLY: never edit this file once merged; add 0011_*.sql instead.
--
-- suspended_identities: written only when a user whose tagalong_suspended_at
--   is set deletes their account. One row per sign-in identity that account
--   had: id_hash = base64url HMAC-SHA256 over "google:<sub>" or
--   "apple:<sub>", keyed by HKDF(SESSION_SECRET, "tagalong:suspended-id:v1").
--   Never a raw sub, email or name. A new account created by the same
--   identity starts suspended (tagalong_suspended_at = suspended_at).
--   Rotating SESSION_SECRET makes existing rows unmatchable (fails open).

CREATE TABLE IF NOT EXISTS suspended_identities (
	id_hash      TEXT PRIMARY KEY,
	suspended_at TEXT NOT NULL,
	created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
