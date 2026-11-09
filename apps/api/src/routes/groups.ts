/**
 * Phase 5 (BUILD_SPEC §6): one group per event, its members and its chat.
 * A group is found from a plan the user owns (canSeeEvent); everything inside
 * it needs membership. A group the user is not in is a 404.
 */
import { Hono } from "hono";
import {
	JoinGroupSchema,
	SetInterestSchema,
	type GroupDetail,
	type GroupMember,
	type GroupSummary,
} from "@tagalong/shared";
import { deferOf, kick } from "../chat/notify.js";
import { HttpError, invalidInput, newId, nowIso, readJson } from "../lib/http.js";
import {
	adult,
	canSeeEvent,
	member,
	NOT_BLOCKED,
	requireMember,
	type TgEnv,
} from "../tagalong/access.js";
import { LIST_MAX, limitJoin, limitMessageRead } from "../tagalong/limits.js";
import { deleteOwnMessage, listMessages, sendMessage } from "../tagalong/messages.js";

export const groups = new Hono<TgEnv>();

const INTEREST_RULE = "Interest is up to 140 characters.";

async function summary(db: D1Database, eventId: string, me: string): Promise<GroupSummary> {
	const row = await db
		.prepare(
			`SELECT g.id AS group_id,
			   (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
			   EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.user_id = ?) AS joined
			 FROM event_groups g WHERE g.event_id = ?`,
		)
		.bind(me, eventId)
		.first<{ group_id: string; member_count: number; joined: number }>();
	return row
		? { group_id: row.group_id, member_count: row.member_count, joined: row.joined === 1 }
		: { group_id: null, member_count: 0, joined: false };
}

/**
 * "Who else is going?" for an event the user has a plan for. Needs sign-in
 * and 18+, not opt-in, so the plan page can offer to join. Only a count.
 */
groups.get("/events/:eventId/group", ...adult, async (c) => {
	const me = c.get("userId");
	const eventId = c.req.param("eventId");
	if (!(await canSeeEvent(c.env.DB, me, eventId)))
		throw new HttpError(404, "not_found", "No such event.");
	return c.json(await summary(c.env.DB, eventId, me));
});

groups.post("/events/:eventId/group/join", ...member, async (c) => {
	const u = c.get("tg");
	const eventId = c.req.param("eventId");
	const body = JoinGroupSchema.safeParse(await readJson(c));
	if (!body.success) throw invalidInput(body.error.issues, INTEREST_RULE);
	if (!(await canSeeEvent(c.env.DB, u.id, eventId)))
		throw new HttpError(404, "not_found", "No such event.");
	await limitJoin(c.env.DB, u);

	const group = await c.env.DB.prepare(
		`INSERT INTO event_groups (id, event_id) VALUES (?, ?)
		 ON CONFLICT (event_id) DO UPDATE SET event_id = excluded.event_id
		 RETURNING id`,
	)
		.bind(newId(), eventId)
		.first<{ id: string }>();
	if (!group) throw new HttpError(500, "internal", "Could not open the group.");

	// Interest on (re)join, one statement: omitted keeps what a member already
	// had (NULL for a new member), null clears it, a string replaces it.
	const interest = body.data.interest;
	await c.env.DB.prepare(
		`INSERT INTO group_members (group_id, user_id, interest, joined_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (group_id, user_id) DO UPDATE SET
		   interest = CASE WHEN ? = 1 THEN excluded.interest ELSE group_members.interest END`,
	)
		.bind(group.id, u.id, interest ?? null, nowIso(), interest === undefined ? 0 : 1)
		.run();
	return c.json(await summary(c.env.DB, eventId, u.id));
});

groups.post("/groups/:id/leave", ...member, async (c) => {
	const me = c.get("userId");
	const groupId = c.req.param("id");
	const res = await c.env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
		.bind(groupId, me)
		.run();
	if (!res.meta.changes) throw new HttpError(404, "not_found", "No such group.");
	deferOf(c)(kick(c.env, "group", groupId, [me]));
	return c.json({ left: true });
});

groups.post("/groups/:id/interest", ...member, async (c) => {
	const me = c.get("userId");
	const body = SetInterestSchema.safeParse(await readJson(c));
	if (!body.success) throw invalidInput(body.error.issues, INTEREST_RULE);
	const interest = body.data.interest ?? null;
	const res = await c.env.DB.prepare(
		"UPDATE group_members SET interest = ? WHERE group_id = ? AND user_id = ?",
	)
		.bind(interest, c.req.param("id"), me)
		.run();
	if (!res.meta.changes) throw new HttpError(404, "not_found", "No such group.");
	return c.json({ interest });
});

/** The event and its members (name, city, interest), hiding blocks both ways. */
groups.get("/groups/:id", ...member, async (c) => {
	const me = c.get("userId");
	const groupId = c.req.param("id");
	const db = c.env.DB;
	await requireMember(db, groupId, me);
	const event = await db
		.prepare(
			`SELECT e.id, e.name, e.starts_at, e.local_date, e.city
			 FROM event_groups g JOIN events e ON e.id = g.event_id WHERE g.id = ?`,
		)
		.bind(groupId)
		.first<GroupDetail["event"]>();
	if (!event) throw new HttpError(404, "not_found", "No such group.");
	const { results } = await db
		.prepare(
			`SELECT m.user_id, u.tagalong_name AS name, u.tagalong_city AS city, m.interest
			 FROM group_members m JOIN users u ON u.id = m.user_id
			 WHERE m.group_id = ? AND u.tagalong_opt_in_at IS NOT NULL
			   AND u.tagalong_suspended_at IS NULL AND u.tagalong_name IS NOT NULL
			   AND u.deleted_at IS NULL
			   AND ${NOT_BLOCKED("m.user_id")}
			 ORDER BY m.joined_at, m.user_id LIMIT ?`,
		)
		.bind(groupId, me, me, LIST_MAX)
		.all<Omit<GroupMember, "is_me"> & { city: string | null }>();
	const members: GroupMember[] = results.map((r) => ({
		user_id: r.user_id,
		name: r.name,
		city: r.city ?? "",
		interest: r.interest,
		is_me: r.user_id === me,
	}));
	const detail: GroupDetail = { group_id: groupId, event, members };
	return c.json(detail);
});

groups.get("/groups/:id/messages", ...member, async (c) => {
	const me = c.get("userId");
	const groupId = c.req.param("id");
	await limitMessageRead(c.env.DB, me);
	await requireMember(c.env.DB, groupId, me);
	return c.json(
		await listMessages(c.env.DB, "group", groupId, me, {
			before: c.req.query("before"),
			after: c.req.query("after"),
		}),
	);
});

groups.post("/groups/:id/messages", ...member, async (c) => {
	const u = c.get("tg");
	const groupId = c.req.param("id");
	const input = await readJson(c);
	await requireMember(c.env.DB, groupId, u.id);
	const message = await sendMessage(c.env, deferOf(c), "group", groupId, u, input);
	return c.json({ message }, 201);
});

/** The author deletes their own message (group or DM). Broadcasts {type:'deleted'}. */
groups.post("/messages/:id/delete", ...member, async (c) => {
	await deleteOwnMessage(c.env, deferOf(c), c.req.param("id"), c.get("userId"));
	return c.json({ deleted: true });
});
