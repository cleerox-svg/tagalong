/**
 * Group and DM messages. D1 is the only store; the ChatRoom Durable Object only
 * fans out (chat/notify.ts). Deletion is soft so reports can still be reviewed.
 *
 * Cursor: `<created_at>|<id>`, ordered by (created_at, id). `before` pages back
 * through history; `after` is for polling and catch-up after a reconnect.
 */
import type { ChatMessage, RoomKind } from "@tagalong/shared";
import { SendMessageSchema } from "@tagalong/shared";
import { broadcast } from "../chat/notify.js";
import { HttpError, newId, nowIso } from "../lib/http.js";
import { blockRelatedIds, NOT_BLOCKED, type TagalongUser } from "./access.js";
import { checkMessageBody, limitMessage } from "./limits.js";

export const PAGE_SIZE = 50;

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([A-Za-z0-9-]{1,64})$/;

export const cursorOf = (m: { created_at: string; id: string }) => `${m.created_at}|${m.id}`;

function parseCursor(raw: string | undefined): { at: string; id: string } | null {
	if (raw === undefined || raw === "") return null;
	const m = CURSOR_RE.exec(raw);
	if (!m || !m[1] || !m[2])
		throw new HttpError(400, "bad_cursor", "That page marker isn't valid. Reload the chat.");
	return { at: m[1], id: m[2] };
}

export interface MessagePage {
	/** Oldest first. */
	messages: ChatMessage[];
	/** More exist beyond this page in the direction asked (older, or newer for `after`). */
	has_more: boolean;
	/** Cursor of the oldest message returned (pass as `before`), or null when none. */
	before: string | null;
	/** Cursor of the newest message returned, else the `after` given (pass as `after`). */
	after: string | null;
}

const roomColumn = (kind: RoomKind) => (kind === "group" ? "m.group_id" : "m.connection_id");

/**
 * One page of non-deleted messages in a room, hiding anyone in a block
 * relation with `me` either way. Access must already be checked.
 */
export async function listMessages(
	db: D1Database,
	kind: RoomKind,
	roomId: string,
	me: string,
	q: { before?: string | undefined; after?: string | undefined },
): Promise<MessagePage> {
	if (q.before && q.after)
		throw new HttpError(400, "bad_cursor", "Use either before or after, not both.");
	const before = parseCursor(q.before);
	const after = parseCursor(q.after);

	const where = [`${roomColumn(kind)} = ?`, "m.deleted_at IS NULL", NOT_BLOCKED("m.user_id")];
	const binds: unknown[] = [roomId, me, me];
	let order = "DESC";
	if (before) {
		where.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
		binds.push(before.at, before.at, before.id);
	} else if (after) {
		where.push("(m.created_at > ? OR (m.created_at = ? AND m.id > ?))");
		binds.push(after.at, after.at, after.id);
		order = "ASC";
	}
	const { results } = await db
		.prepare(
			`SELECT m.id, m.user_id, u.tagalong_name AS name, m.body, m.created_at
			 FROM messages m JOIN users u ON u.id = m.user_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY m.created_at ${order}, m.id ${order} LIMIT ?`,
		)
		.bind(...binds, PAGE_SIZE + 1)
		.all<{ id: string; user_id: string; name: string | null; body: string; created_at: string }>();

	const has_more = results.length > PAGE_SIZE;
	const page = results.slice(0, PAGE_SIZE);
	if (order === "DESC") page.reverse();
	const messages = page.map((r): ChatMessage => ({
		id: r.id,
		room_kind: kind,
		room_id: roomId,
		user_id: r.user_id,
		name: r.name ?? "Tagalong member",
		body: r.body,
		created_at: r.created_at,
		is_me: r.user_id === me,
	}));
	const first = messages[0];
	const last = messages[messages.length - 1];
	return {
		messages,
		has_more,
		before: first ? cursorOf(first) : null,
		after: last ? cursorOf(last) : (q.after ?? null),
	};
}

/**
 * Validates, applies the link rule and rate limits, stores and fans out.
 * Access to the room must already be checked.
 */
export async function sendMessage(
	env: Env,
	kind: RoomKind,
	roomId: string,
	u: TagalongUser,
	input: unknown,
): Promise<ChatMessage> {
	const parsed = SendMessageSchema.safeParse(input);
	if (!parsed.success)
		throw new HttpError(400, "invalid", "A message is 1 to 1000 characters.", parsed.error.issues);
	const body = parsed.data.body;
	checkMessageBody(u, body);
	await limitMessage(env.DB, u);

	const message: ChatMessage = {
		id: newId(),
		room_kind: kind,
		room_id: roomId,
		user_id: u.id,
		name: u.name,
		body,
		created_at: nowIso(),
		is_me: true,
	};
	await env.DB.prepare(
		`INSERT INTO messages (id, group_id, connection_id, user_id, body, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			message.id,
			kind === "group" ? roomId : null,
			kind === "dm" ? roomId : null,
			u.id,
			body,
			message.created_at,
		)
		.run();

	await broadcast(
		env,
		kind,
		roomId,
		{ type: "message", message },
		await blockRelatedIds(env.DB, u.id),
	);
	return message;
}

/** The author soft-deletes their own message. Anything else is a 404. */
export async function deleteOwnMessage(env: Env, messageId: string, userId: string) {
	const row = await env.DB.prepare(
		`UPDATE messages SET deleted_at = ?, deleted_by = 'author'
		 WHERE id = ? AND user_id = ? AND deleted_at IS NULL
		 RETURNING group_id, connection_id`,
	)
		.bind(nowIso(), messageId, userId)
		.first<{ group_id: string | null; connection_id: string | null }>();
	if (!row) throw new HttpError(404, "not_found", "No such message.");
	await broadcastDeleted(env, messageId, row);
}

export async function broadcastDeleted(
	env: Env,
	messageId: string,
	room: { group_id: string | null; connection_id: string | null },
) {
	if (room.group_id)
		await broadcast(env, "group", room.group_id, { type: "deleted", id: messageId });
	else if (room.connection_id)
		await broadcast(env, "dm", room.connection_id, { type: "deleted", id: messageId });
}
