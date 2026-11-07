/**
 * Leaving Tagalong, by opting out or by suspension: one batch that applies
 * the caller's user update, removes every group membership and closes every
 * open connection (closed_by = the leaving user), then closes the user's
 * sockets in those groups and both sides' sockets in those DMs (deferred).
 * Messages stay.
 */
import { kickFromRooms, type Defer } from "../chat/notify.js";

export async function leaveTagalong(
	env: Env,
	defer: Defer,
	userId: string,
	now: string,
	userUpdate: D1PreparedStatement,
	extra: D1PreparedStatement[] = [],
): Promise<void> {
	const db = env.DB;
	const [, groups, conns] = await db.batch([
		userUpdate,
		db.prepare("DELETE FROM group_members WHERE user_id = ? RETURNING group_id").bind(userId),
		db
			.prepare(
				`UPDATE connections SET status = 'closed', responded_at = ?, closed_by = ?
				 WHERE (user_lo = ? OR user_hi = ?) AND status IN ('pending', 'accepted')
				 RETURNING id, user_lo, user_hi`,
			)
			.bind(now, userId, userId, userId),
		...extra,
	]);
	defer(
		kickFromRooms(
			env,
			userId,
			(groups?.results ?? []) as { group_id: string }[],
			(conns?.results ?? []) as { id: string; user_lo: string; user_hi: string }[],
		),
	);
}
