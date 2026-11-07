/**
 * Blocks (BUILD_SPEC §6): one row per direction; the app hides both ways,
 * everywhere (members, messages, profiles, connect, DMs, broadcasts). Blocking
 * closes any connection between the two and drops their DM sockets.
 */
import type { BlockedUser } from "@tagalong/shared";
import { kick } from "../chat/notify.js";
import { HttpError, nowIso } from "../lib/http.js";

export async function blockUser(env: Env, me: string, target: string): Promise<void> {
	if (target === me) throw new HttpError(400, "invalid", "You can't block yourself.");
	const exists = await env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ?").bind(target).first();
	if (!exists) throw new HttpError(404, "not_found", "No such user.");

	const [lo, hi] = me < target ? [me, target] : [target, me];
	const now = nowIso();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)
			 ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
		).bind(me, target, now),
		env.DB.prepare(
			`UPDATE connections SET status = 'closed', responded_at = ?
			 WHERE user_lo = ? AND user_hi = ? AND status IN ('pending', 'accepted')`,
		).bind(now, lo, hi),
	]);
	// Drop both sides' DM sockets, whatever the connection's status was.
	const conn = await env.DB.prepare("SELECT id FROM connections WHERE user_lo = ? AND user_hi = ?")
		.bind(lo, hi)
		.first<{ id: string }>();
	if (conn) await kick(env, "dm", conn.id, [me, target]);
}

export async function unblockUser(db: D1Database, me: string, target: string): Promise<void> {
	await db
		.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?")
		.bind(me, target)
		.run();
}

/** Who I have blocked (not who blocked me: that is never revealed). */
export async function listBlocks(db: D1Database, me: string): Promise<BlockedUser[]> {
	const { results } = await db
		.prepare(
			`SELECT b.blocked_id AS user_id, u.tagalong_name AS name, b.created_at AS blocked_at
			 FROM blocks b JOIN users u ON u.id = b.blocked_id
			 WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
		)
		.bind(me)
		.all<BlockedUser>();
	return results;
}
