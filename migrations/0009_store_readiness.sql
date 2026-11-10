-- 0009_store_readiness: phase 7 (store readiness): Sign in with Apple and
-- in-app account deletion.
--
-- APPEND-ONLY: never edit this file once merged; add 0010_*.sql instead.
--
-- users.apple_sub: the stable Apple account id (the id_token `sub`), unique.
--   NULL for Google-only accounts and for deleted accounts.
-- users.apple_refresh_token_enc: Apple's refresh token, AES-GCM encrypted with
--   a key derived from SESSION_SECRET (base64url iv.ciphertext). Kept only so
--   the token can be revoked when the account is deleted.
-- users.deleted_at: set when the user deletes their account. The row stays as a
--   tombstone (reports, moderation history and message authorship point at
--   it); every personal field is cleared and no session can use it again.
--
-- users.google_sub is NOT NULL UNIQUE (0002) and cannot be relaxed without a
-- table rebuild, so it carries sentinels instead:
--   Apple-only accounts:  google_sub = 'apple:' || apple_sub
--   deleted accounts:     google_sub = 'deleted:' || id
-- Google subs are numeric strings, so neither prefix can collide with one.
--
-- reports_target: moderation and account deletion look reports up by target
--   (is this message reported?).

ALTER TABLE users ADD COLUMN apple_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_apple_sub ON users (apple_sub);
ALTER TABLE users ADD COLUMN apple_refresh_token_enc TEXT;
ALTER TABLE users ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS reports_target ON reports (target_type, target_id);
