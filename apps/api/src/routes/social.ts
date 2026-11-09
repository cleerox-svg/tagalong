/**
 * Phase 5 (BUILD_SPEC §6): mutual connect, DMs, blocks and reports.
 *
 * DMs only exist once both people have opted in to each other: one asks, the
 * other accepts (or asks back). Connecting needs the "meet in public places"
 * safety note acknowledged, a shared group and no block either way.
 */
import { Hono } from "hono";
import {
	BlockRequestSchema,
	ConnectRequestSchema,
	ReportInputSchema,
	type Connection,
} from "@tagalong/shared";
import { deferOf, kick } from "../chat/notify.js";
import { HttpError, LIVE_USER, newId, nowIso, readJson } from "../lib/http.js";
import { connectionEvent, notify } from "../push/dispatch.js";
import {
	adult,
	isActiveTagalongUser,
	isBlockedEitherWay,
	loadConnection,
	member,
	NOT_BLOCKED,
	SHOWN_NAME,
	otherParty,
	pairOf,
	requireDm,
	shareAGroup,
	type ConnectionRow,
	type TgEnv,
} from "../tagalong/access.js";
import { blockUser, listBlocks, unblockUser } from "../tagalong/blocks.js";
import {
	LIST_MAX,
	limitBlock,
	limitConnect,
	limitMessageRead,
	limitReport,
} from "../tagalong/limits.js";
import { listMessages, sendMessage } from "../tagalong/messages.js";
import { createReport } from "../tagalong/reports.js";

export const social = new Hono<TgEnv>();

const CONNECTION_COLUMNS =
	"c.id, c.user_lo, c.user_hi, c.requested_by, c.status, c.created_at, c.responded_at, c.closed_by";

type ConnectionWithOther = ConnectionRow & { other_name: string | null; other_city: string | null };

function toConnection(r: ConnectionWithOther, me: string): Connection {
	return {
		id: r.id,
		other_user_id: otherParty(r, me),
		other_name: r.other_name ?? "Tagalong member",
		other_city: r.other_city ?? "",
		status: r.status,
		requested_by_me: r.requested_by === me,
		created_at: r.created_at,
		responded_at: r.responded_at,
	};
}

async function connectionView(db: D1Database, id: string, me: string): Promise<Connection> {
	const row = await db
		.prepare(
			`SELECT ${CONNECTION_COLUMNS}, ${SHOWN_NAME("u")} AS other_name, u.tagalong_city AS other_city
			 FROM connections c
			 JOIN users u ON u.id = CASE WHEN c.user_lo = ? THEN c.user_hi ELSE c.user_lo END
			 WHERE c.id = ? AND (c.user_lo = ? OR c.user_hi = ?)`,
		)
		.bind(me, id, me, me)
		.first<ConnectionWithOther>();
	if (!row) throw new HttpError(404, "not_found", "No such connection.");
	return toConnection(row, me);
}

const safetyAckRequired = () =>
	new HttpError(
		409,
		"safety_ack_required",
		"Read the safety note about meeting in public places first.",
	);

/** My connections (every status, newest activity first, capped), hiding block relations. */
social.get("/connections", ...member, async (c) => {
	const me = c.get("userId");
	const { results } = await c.env.DB.prepare(
		`SELECT ${CONNECTION_COLUMNS}, ${SHOWN_NAME("u")} AS other_name, u.tagalong_city AS other_city
		 FROM connections c
		 JOIN users u ON u.id = CASE WHEN c.user_lo = ? THEN c.user_hi ELSE c.user_lo END
		 WHERE (c.user_lo = ? OR c.user_hi = ?) AND ${NOT_BLOCKED("u.id")}
		 ORDER BY COALESCE(c.responded_at, c.created_at) DESC LIMIT ?`,
	)
		.bind(me, me, me, me, me, LIST_MAX)
		.all<ConnectionWithOther>();
	return c.json({ connections: results.map((r) => toConnection(r, me)) });
});

/**
 * Ask to connect. If they had already asked me, this accepts. A request
 * someone declined, or a connection someone else closed, can't be re-sent by
 * the other person (the row comes back unchanged); the person who declined
 * or closed it may ask again, which starts a new request. Rows closed before
 * closed_by existed (NULL) can be reopened by either side.
 *
 * The INSERT's SELECT is guarded by NOT EXISTS (block either way), so a block
 * that lands after the checks above stops both the insert and the
 * ON CONFLICT update: no row comes back, and the answer is a 404.
 *
 * A push goes out only on a real transition, read from the same statement:
 * a new or reopened request gets created_at = now, an accept gets
 * responded_at = now. Re-posting a pending request or an accepted connection
 * changes neither, so it notifies nobody.
 */
social.post("/connections", ...member, async (c) => {
	const u = c.get("tg");
	const body = ConnectRequestSchema.safeParse(await readJson(c));
	if (!body.success) throw new HttpError(400, "invalid", "Send { user_id }.", body.error.issues);
	const target = body.data.user_id;
	if (target === u.id) throw new HttpError(400, "invalid", "You can't connect with yourself.");
	if (!u.safety_acked) throw safetyAckRequired();
	const db = c.env.DB;
	const notFound = new HttpError(404, "not_found", "No such person.");
	if (!(await shareAGroup(db, u.id, target))) throw notFound;
	if (await isBlockedEitherWay(db, u.id, target)) throw notFound;
	if (!(await isActiveTagalongUser(db, target))) throw notFound;
	await limitConnect(db, u);

	const [lo, hi] = pairOf(u.id, target);
	const theyAsked =
		"(connections.status = 'pending' AND connections.requested_by <> excluded.requested_by)";
	const reopen = `((connections.status = 'closed'
		  AND (connections.closed_by IS NULL OR connections.closed_by = excluded.requested_by))
		OR (connections.status = 'declined' AND connections.requested_by <> excluded.requested_by))`;
	const now = nowIso();
	const row = await db
		.prepare(
			`INSERT INTO connections (id, user_lo, user_hi, requested_by, status, created_at)
			 SELECT ?, ?, ?, ?, 'pending', ?
			 WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = ?)
			   OR (b.blocker_id = ? AND b.blocked_id = ?))
			   AND ${LIVE_USER} AND ${LIVE_USER}
			 ON CONFLICT (user_lo, user_hi) DO UPDATE SET
			   status = CASE WHEN ${theyAsked} THEN 'accepted' WHEN ${reopen} THEN 'pending'
			     ELSE connections.status END,
			   responded_at = CASE WHEN ${theyAsked} THEN excluded.created_at WHEN ${reopen} THEN NULL
			     ELSE connections.responded_at END,
			   created_at = CASE WHEN ${reopen} THEN excluded.created_at ELSE connections.created_at END,
			   closed_by = CASE WHEN ${reopen} THEN NULL ELSE connections.closed_by END,
			   requested_by = CASE WHEN ${reopen} THEN excluded.requested_by ELSE connections.requested_by END
			 RETURNING id, created_at, responded_at`,
		)
		.bind(newId(), lo, hi, u.id, now, lo, hi, hi, lo, lo, hi)
		.first<{ id: string; created_at: string; responded_at: string | null }>();
	if (!row) throw notFound;
	const connection = await connectionView(db, row.id, u.id);
	const changed = row.created_at === now || row.responded_at === now;
	notify(c.env, deferOf(c), changed ? connectionEvent(connection, u.id) : null);
	return c.json({ connection });
});

/** Respond to a request someone else made. */
async function respond(c: import("hono").Context<TgEnv>, to: "accepted" | "declined") {
	const u = c.get("tg");
	const db = c.env.DB;
	const conn = await loadConnection(db, c.req.param("id") ?? "", u.id);
	if (!conn || (await isBlockedEitherWay(db, u.id, otherParty(conn, u.id))))
		throw new HttpError(404, "not_found", "No such connection.");
	if (conn.status !== "pending" || conn.requested_by === u.id)
		throw new HttpError(409, "not_pending", "There's no request waiting for your answer.");
	if (to === "accepted" && !u.safety_acked) throw safetyAckRequired();
	if (to === "accepted" && !(await isActiveTagalongUser(db, otherParty(conn, u.id))))
		throw new HttpError(404, "not_found", "No such connection.");
	const res = await db
		.prepare(
			`UPDATE connections SET status = ?, responded_at = ?
			 WHERE id = ? AND status = 'pending' AND requested_by <> ?`,
		)
		.bind(to, nowIso(), conn.id, u.id)
		.run();
	if (!res.meta.changes)
		throw new HttpError(409, "not_pending", "There's no request waiting for your answer.");
	const connection = await connectionView(db, conn.id, u.id);
	notify(c.env, deferOf(c), connectionEvent(connection, u.id));
	return c.json({ connection });
}

social.post("/connections/:id/accept", ...member, (c) => respond(c, "accepted"));
social.post("/connections/:id/decline", ...member, (c) => respond(c, "declined"));

/**
 * Either side withdraws a pending request or ends an accepted connection.
 * closed_by records who: only they may reopen it (see POST /connections).
 */
social.post("/connections/:id/close", ...member, async (c) => {
	const me = c.get("userId");
	const db = c.env.DB;
	const conn = await loadConnection(db, c.req.param("id"), me);
	if (!conn) throw new HttpError(404, "not_found", "No such connection.");
	const res = await db
		.prepare(
			`UPDATE connections SET status = 'closed', responded_at = ?, closed_by = ?
			 WHERE id = ? AND status IN ('pending', 'accepted')`,
		)
		.bind(nowIso(), me, conn.id)
		.run();
	if (!res.meta.changes) throw new HttpError(409, "not_open", "This connection is already closed.");
	deferOf(c)(kick(c.env, "dm", conn.id, [conn.user_lo, conn.user_hi]));
	return c.json({ connection: await connectionView(db, conn.id, me) });
});

social.get("/dms/:connectionId/messages", ...member, async (c) => {
	const me = c.get("userId");
	await limitMessageRead(c.env.DB, me);
	const conn = await requireDm(c.env.DB, c.req.param("connectionId"), me);
	return c.json(
		await listMessages(c.env.DB, "dm", conn.id, me, {
			before: c.req.query("before"),
			after: c.req.query("after"),
		}),
	);
});

social.post("/dms/:connectionId/messages", ...member, async (c) => {
	const u = c.get("tg");
	const input = await readJson(c);
	const conn = await requireDm(c.env.DB, c.req.param("connectionId"), u.id);
	const message = await sendMessage(c.env, deferOf(c), "dm", conn.id, u, input);
	return c.json({ message }, 201);
});

// Blocks need only sign-in and 18+: blocking must work even after opting out.

social.post("/blocks", ...adult, async (c) => {
	const me = c.get("userId");
	const body = BlockRequestSchema.safeParse(await readJson(c));
	if (!body.success) throw new HttpError(400, "invalid", "Send { user_id }.", body.error.issues);
	await limitBlock(c.env.DB, me);
	await blockUser(c.env, deferOf(c), me, body.data.user_id);
	return c.json({ blocked: true });
});

social.get("/blocks", ...adult, async (c) => {
	return c.json({ blocks: await listBlocks(c.env.DB, c.get("userId")) });
});

social.post("/blocks/:userId/remove", ...adult, async (c) => {
	const me = c.get("userId");
	await limitBlock(c.env.DB, me);
	await unblockUser(c.env.DB, me, c.req.param("userId"));
	return c.json({ blocked: false });
});

social.post("/reports", ...member, async (c) => {
	const u = c.get("tg");
	const raw = await readJson(c);
	const body = ReportInputSchema.safeParse(raw);
	if (!body.success)
		throw new HttpError(
			400,
			"invalid",
			"Report a message or a person, with a reason.",
			body.error.issues,
		);
	await limitReport(c.env.DB, u);
	const created = await createReport(c.env.DB, u.id, body.data);
	return c.json({ reported: true }, created ? 201 : 200);
});
