/**
 * Worker-side calls into the ChatRoom Durable Object. Fan-out is best effort:
 * the message is already in D1, and a client whose socket missed it catches
 * up by polling `?after=`. A failed broadcast or kick is logged, not thrown.
 *
 * Fan-out runs after the response: routes pass `deferOf(c)`, which hands the
 * work to `executionCtx.waitUntil`.
 */
import type { Context } from "hono";
import type { ChatEvent, RoomKind } from "@tagalong/shared";

export const roomName = (kind: RoomKind, id: string) => `${kind}:${id}`;

export const roomStub = (env: Env, kind: RoomKind, id: string) =>
	env.CHAT_ROOM.getByName(roomName(kind, id));

/** Schedules background work (fan-out) so it doesn't delay the response. */
export type Defer = (work: Promise<unknown>) => void;

/** The request's waitUntil, as a Defer. */
export const deferOf =
	(c: Context): Defer =>
	(work) =>
		c.executionCtx.waitUntil(work);

/**
 * Who may receive an event in a room. `allow` is everyone currently entitled
 * to be in the room; the DO closes any other user's sockets. `skip` (a subset
 * of `allow`) stays connected but does not get this event: people in a block
 * relation with the author.
 */
export interface Audience {
	allow: string[];
	skip: string[];
}

/**
 * One D1 query. A group: current members who are opted in, not suspended and
 * 18+. A DM: both parties while the connection is accepted with no block
 * either way, else nobody. `authorId` is the user whose content the event
 * carries; members in a block relation with them are skipped.
 */
export async function roomAudience(
	db: D1Database,
	kind: RoomKind,
	roomId: string,
	authorId: string,
): Promise<Audience> {
	if (kind === "group") {
		const { results } = await db
			.prepare(
				`SELECT m.user_id AS id, EXISTS (SELECT 1 FROM blocks b
				   WHERE (b.blocker_id = ? AND b.blocked_id = m.user_id)
				      OR (b.blocker_id = m.user_id AND b.blocked_id = ?)) AS blocked
				 FROM group_members m JOIN users u ON u.id = m.user_id
				 WHERE m.group_id = ? AND u.tagalong_opt_in_at IS NOT NULL
				   AND u.tagalong_suspended_at IS NULL AND u.birthdate_verified_18 = 1`,
			)
			.bind(authorId, authorId, roomId)
			.all<{ id: string; blocked: number }>();
		return {
			allow: results.map((r) => r.id),
			skip: results.filter((r) => r.blocked === 1).map((r) => r.id),
		};
	}
	const row = await db
		.prepare(
			`SELECT c.user_lo, c.user_hi FROM connections c
			 WHERE c.id = ? AND c.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM blocks b
			   WHERE (b.blocker_id = c.user_lo AND b.blocked_id = c.user_hi)
			      OR (b.blocker_id = c.user_hi AND b.blocked_id = c.user_lo))`,
		)
		.bind(roomId)
		.first<{ user_lo: string; user_hi: string }>();
	return { allow: row ? [row.user_lo, row.user_hi] : [], skip: [] };
}

/** Looks up the room's audience (one query) and fans `event` out. Never throws. */
export async function broadcast(
	env: Env,
	kind: RoomKind,
	id: string,
	event: ChatEvent,
	authorId: string,
): Promise<void> {
	try {
		const audience = await roomAudience(env.DB, kind, id, authorId);
		await roomStub(env, kind, id).broadcast(event, audience);
	} catch (err) {
		console.error("chat broadcast failed", roomName(kind, id), err);
	}
}

/** Closes the given users' sockets in one room. Never throws. */
export async function kick(env: Env, kind: RoomKind, id: string, userIds: string[]) {
	await Promise.all(
		userIds.map(async (userId) => {
			try {
				await roomStub(env, kind, id).kick(userId);
			} catch (err) {
				console.error("chat kick failed", roomName(kind, id), err);
			}
		}),
	);
}

/** Closes a user's sockets in the groups they left and both sides' sockets in closed DMs. */
export async function kickFromRooms(
	env: Env,
	userId: string,
	groups: { group_id: string }[],
	conns: { id: string; user_lo: string; user_hi: string }[],
) {
	await Promise.all([
		...groups.map((g) => kick(env, "group", g.group_id, [userId])),
		...conns.map((c) => kick(env, "dm", c.id, [c.user_lo, c.user_hi])),
	]);
}
