/**
 * Blocks (BUILD_SPEC §6): one row per direction; the app hides both ways,
 * everywhere (members, messages, profiles, connect, DMs, broadcasts). Blocking
 * closes any connection between the two and drops their DM sockets.
 */
import type { BlockedUser } from "@tagalong/shared";
import { kick, type Defer } from "../chat/notify.js";
import { HttpError, nowIso } from "../lib/http.js";
import { pairOf, SHOWN_NAME } from "./access.js";
import { LIST_MAX } from "./limits.js";

/**
 * Blocks `target`. Answers the same whether or not `target` is a real user
 * (no account-existence oracle); a row is only written for one that exists.
 */
export async function blockUser(env: Env, defer: Defer, me: string, target: string): Promise<void> {
	if (target === me) throw new HttpError(400, "invalid", "You can't block yourself.");

	const [lo, hi] = pairOf(me, target);
	const now = nowIso();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO blocks (blocker_id, blocked_id, created_at)
			 SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL)
			 ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
		).bind(me, target, now, target),
		env.DB.prepare(
			`UPDATE connections SET status = 'closed', responded_at = ?, closed_by = ?
			 WHERE user_lo = ? AND user_hi = ? AND status IN ('pending', 'accepted')`,
		).bind(now, me, lo, hi),
	]);
	// Drop both sides' DM sockets, whatever the connection's status was. No
	// connection row means there is nothing to drop (and says nothing about
	// whether the user exists: most pairs never connected).
	const conn = await env.DB.prepare("SELECT id FROM connections WHERE user_lo = ? AND user_hi = ?")
		.bind(lo, hi)
		.first<{ id: string }>();
	if (conn) defer(kick(env, "dm", conn.id, [me, target]));
}

export async function unblockUser(db: D1Database, me: string, target: string): Promise<void> {
	await db
		.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?")
		.bind(me, target)
		.run();
}

/** Who I have blocked (not who blocked me: that is never revealed). Newest first, capped. */
export async function listBlocks(db: D1Database, me: string): Promise<BlockedUser[]> {
	const { results } = await db
		.prepare(
			`SELECT b.blocked_id AS user_id, ${SHOWN_NAME("u")} AS name, b.created_at AS blocked_at
			 FROM blocks b JOIN users u ON u.id = b.blocked_id
			 WHERE b.blocker_id = ? ORDER BY b.created_at DESC LIMIT ?`,
		)
		.bind(me, LIST_MAX)
		.all<BlockedUser>();
	return results;
}
