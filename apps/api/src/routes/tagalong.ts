/**
 * Phase 5 (BUILD_SPEC §6): Tagalong opt-in/out, the safety note, and profiles.
 */
import { Hono } from "hono";
import { TagalongOptInSchema, type SharedGroup, type TagalongProfile } from "@tagalong/shared";
import { deferOf } from "../chat/notify.js";
import { HttpError, nowIso, readJson } from "../lib/http.js";
import {
	adult,
	isActiveTagalongUser,
	isBlockedEitherWay,
	loadConnectionByPair,
	loadTagalongRow,
	member,
	tagalongStatus,
	type TgEnv,
} from "../tagalong/access.js";
import { leaveTagalong } from "../tagalong/leave.js";
import { limitOptIn } from "../tagalong/limits.js";

export const tagalong = new Hono<TgEnv>();

/**
 * Turn Tagalong on, or change the shown name/city. The client supplies both
 * (never defaulted from the Google name or email). A suspended account stays
 * suspended.
 */
tagalong.post("/tagalong/opt-in", ...adult, async (c) => {
	const userId = c.get("userId");
	const body = TagalongOptInSchema.safeParse(await readJson(c));
	if (!body.success)
		throw new HttpError(
			400,
			"invalid",
			"Confirm, and give a first name (up to 40 characters) and a city name only.",
			body.error.issues,
		);
	const current = await loadTagalongRow(c.env.DB, userId);
	if (current?.tagalong_suspended_at)
		throw new HttpError(403, "tagalong_suspended", "Your Tagalong access has been suspended.");
	await limitOptIn(c.env.DB, userId);
	const row = await c.env.DB.prepare(
		`UPDATE users SET tagalong_opt_in_at = COALESCE(tagalong_opt_in_at, ?),
		   tagalong_name = ?, tagalong_city = ?
		 WHERE id = ? AND tagalong_suspended_at IS NULL
		 RETURNING created_at, tagalong_opt_in_at, tagalong_name, tagalong_city,
		   tagalong_safety_ack_at, tagalong_trusted_at, tagalong_suspended_at`,
	)
		.bind(nowIso(), body.data.name, body.data.city, userId)
		.first<Parameters<typeof tagalongStatus>[0]>();
	if (!row)
		throw new HttpError(403, "tagalong_suspended", "Your Tagalong access has been suspended.");
	return c.json({ tagalong: tagalongStatus(row) });
});

/**
 * Turn Tagalong off: leave every group, close every open connection, drop
 * sockets. Messages stay. Works while suspended too.
 */
tagalong.post("/tagalong/opt-out", ...adult, async (c) => {
	const userId = c.get("userId");
	await leaveTagalong(
		c.env,
		deferOf(c),
		userId,
		nowIso(),
		c.env.DB.prepare("UPDATE users SET tagalong_opt_in_at = NULL WHERE id = ?").bind(userId),
	);
	const row = await loadTagalongRow(c.env.DB, userId);
	if (!row) throw new HttpError(401, "signed_out", "Sign in first.");
	return c.json({ tagalong: tagalongStatus(row) });
});

/** The "meet in public places" note was shown and acknowledged (needed before connecting). */
tagalong.post("/tagalong/safety-ack", ...member, async (c) => {
	const userId = c.get("userId");
	await c.env.DB.prepare(
		"UPDATE users SET tagalong_safety_ack_at = COALESCE(tagalong_safety_ack_at, ?) WHERE id = ?",
	)
		.bind(nowIso(), userId)
		.run();
	const row = await loadTagalongRow(c.env.DB, userId);
	if (!row) throw new HttpError(401, "signed_out", "Sign in first.");
	return c.json({ tagalong: tagalongStatus(row) });
});

/**
 * A profile: chosen name and city, shared groups, connection state. Visible
 * only when the two share a group or have a pending/accepted connection, the
 * other is active on Tagalong, and neither has blocked the other. Else 404.
 */
tagalong.get("/tagalong/users/:id", ...member, async (c) => {
	const me = c.get("userId");
	const target = c.req.param("id");
	const db = c.env.DB;
	const notFound = () => new HttpError(404, "not_found", "No such person.");
	const isMe = target === me;

	const conn = isMe ? null : await loadConnectionByPair(db, me, target);
	const { results: shared } = await db
		.prepare(
			`SELECT g.id AS group_id, e.name AS event_name, e.starts_at
			 FROM group_members a
			 JOIN group_members b ON b.group_id = a.group_id
			 JOIN event_groups g ON g.id = a.group_id
			 JOIN events e ON e.id = g.event_id
			 WHERE a.user_id = ? AND b.user_id = ?
			 ORDER BY COALESCE(e.starts_at, e.local_date)`,
		)
		.bind(me, target)
		.all<SharedGroup>();

	if (!isMe) {
		const openConn = conn && (conn.status === "pending" || conn.status === "accepted");
		if (shared.length === 0 && !openConn) throw notFound();
		if (await isBlockedEitherWay(db, me, target)) throw notFound();
		if (!(await isActiveTagalongUser(db, target))) throw notFound();
	}
	const user = await db
		.prepare("SELECT tagalong_name AS name, tagalong_city AS city FROM users WHERE id = ?")
		.bind(target)
		.first<{ name: string | null; city: string | null }>();
	if (!user?.name || !user.city) throw notFound();

	const profile: TagalongProfile = {
		user_id: target,
		name: user.name,
		city: user.city,
		is_me: isMe,
		shared_groups: isMe ? [] : shared,
		connection_id: conn?.id ?? null,
		connection_status: conn?.status ?? null,
		requested_by_me: conn ? conn.requested_by === me : null,
	};
	return c.json(profile);
});
