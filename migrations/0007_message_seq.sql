-- 0007_message_seq: phase 5 review fixes (docs/BUILD_SPEC.md §9).
--
-- APPEND-ONLY: never edit this file once merged; add 0008_*.sql instead.
--
-- messages.seq: a global, monotonic sequence number assigned inside the INSERT
--   itself (MAX(seq) + 1). D1 serialises writes, so seq follows commit order,
--   unlike created_at (taken before the write), and polling with
--   `?after=<seq>` can no longer skip a message that committed late with an
--   earlier timestamp. The unique index guards the invariant. Rows written
--   before this migration are numbered in (created_at, id) order.
-- connections.closed_by: who closed a connection. A close by the other party
--   behaves like a decline (the asker can't reopen it); the person who closed
--   it can. NULL on rows closed before this migration (anyone may reopen).

ALTER TABLE messages ADD COLUMN seq INTEGER;

UPDATE messages SET seq = (
	SELECT r.rn FROM (
		SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM messages
	) r WHERE r.id = messages.id
) WHERE seq IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS messages_seq ON messages (seq);
CREATE INDEX IF NOT EXISTS messages_group_seq ON messages (group_id, seq);
CREATE INDEX IF NOT EXISTS messages_conn_seq ON messages (connection_id, seq);

ALTER TABLE connections ADD COLUMN closed_by TEXT REFERENCES users(id);
