/**
 * Group and DM messages. D1 is the only store; the ChatRoom Durable Object only
 * fans out (chat/notify.ts). Deletion is soft so reports can still be reviewed.
 *
 * Order and cursor: `seq` (migration 0007), assigned inside the INSERT in
 * commit order, so a poll with `after` never skips a message that committed
 * late. The cursor is the shared messageCursor / parseMessageCursor format.
 * `before` pages back through history; `after` is for polling and catch-up.
 */
import type { ChatMessage, RoomKind } from "@tagalong/shared";
import { messageCursor, parseMessageCursor, SendMessageSchema } from "@tagalong/shared";
import { broadcast, type Defer } from "../chat/notify.js";
import { HttpError, invalidInput, newId, nowIso } from "../lib/http.js";
import { NOT_BLOCKED, type TagalongUser } from "./access.js";
import { checkMessageBody, limitMessage } from "./limits.js";

export const PAGE_SIZE = 50;

function parseCursor(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const seq = parseMessageCursor(raw);
	if (seq === null)
		throw new HttpError(400, "bad_cursor", "That page marker isn't valid. Reload the chat.");
	return seq;
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
	if (q.before !== undefined && q.after !== undefined)
		throw new HttpError(400, "bad_cursor", "Use either before or after, not both.");
	const before = parseCursor(q.before);
	const after = parseCursor(q.after);

	const where = [`${roomColumn(kind)} = ?`, "m.deleted_at IS NULL", NOT_BLOCKED("m.user_id")];
	const binds: unknown[] = [roomId, me, me];
	let order = "DESC";
	if (before !== null) {
		where.push("m.seq < ?");
		binds.push(before);
	} else if (after !== null) {
		where.push("m.seq > ?");
		binds.push(after);
		order = "ASC";
	}
	const { results } = await db
		.prepare(
			`SELECT m.id, m.user_id, u.tagalong_name AS name, m.body, m.seq, m.created_at
			 FROM messages m JOIN users u ON u.id = m.user_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY m.seq ${order} LIMIT ?`,
		)
		.bind(...binds, PAGE_SIZE + 1)
		.all<{
			id: string;
			user_id: string;
			name: string | null;
			body: string;
			seq: number;
			created_at: string;
		}>();

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
		seq: r.seq,
		created_at: r.created_at,
		is_me: r.user_id === me,
	}));
	const first = messages[0];
	const last = messages[messages.length - 1];
	return {
		messages,
		has_more,
		before: first ? messageCursor(first) : null,
		after: last ? messageCursor(last) : after !== null ? messageCursor({ seq: after }) : null,
	};
}

/**
 * Validates, applies the link rule and rate limits, stores and fans out.
 * Access to the room must already be checked. The fan-out (its audience
 * lookup included) runs through `defer`, after the response.
 */
export async function sendMessage(
	env: Env,
	defer: Defer,
	kind: RoomKind,
	roomId: string,
	u: TagalongUser,
	input: unknown,
): Promise<ChatMessage> {
	const parsed = SendMessageSchema.safeParse(input);
	if (!parsed.success)
		throw invalidInput(parsed.error.issues, "A message is 1 to 1000 characters.");
	const body = parsed.data.body;
	checkMessageBody(u, body);
	await limitMessage(env.DB, u);

	const id = newId();
	const created_at = nowIso();
	// seq = MAX(seq) + 1 inside the INSERT: D1 runs one write at a time, so seq
	// follows commit order; the unique index on seq guards it.
	const row = await env.DB.prepare(
		`INSERT INTO messages (id, group_id, connection_id, user_id, body, created_at, seq)
		 SELECT ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(seq) FROM messages), 0) + 1
		 RETURNING seq`,
	)
		.bind(
			id,
			kind === "group" ? roomId : null,
			kind === "dm" ? roomId : null,
			u.id,
			body,
			created_at,
		)
		.first<{ seq: number }>();
	if (!row) throw new HttpError(500, "internal", "Could not send the message.");

	const message: ChatMessage = {
		id,
		room_kind: kind,
		room_id: roomId,
		user_id: u.id,
		name: u.name,
		body,
		seq: row.seq,
		created_at,
		is_me: true,
	};
	defer(broadcast(env, kind, roomId, { type: "message", message }, u.id));
	return message;
}

/** The author soft-deletes their own message. Anything else is a 404. */
export async function deleteOwnMessage(env: Env, defer: Defer, messageId: string, userId: string) {
	const row = await env.DB.prepare(
		`UPDATE messages SET deleted_at = ?, deleted_by = 'author'
		 WHERE id = ? AND user_id = ? AND deleted_at IS NULL
		 RETURNING group_id, connection_id, user_id`,
	)
		.bind(nowIso(), messageId, userId)
		.first<DeletedRoom>();
	if (!row) throw new HttpError(404, "not_found", "No such message.");
	defer(broadcastDeleted(env, messageId, row));
}

export interface DeletedRoom {
	group_id: string | null;
	connection_id: string | null;
	/** The message's author (block relations with them are skipped). */
	user_id: string;
}

export async function broadcastDeleted(env: Env, messageId: string, room: DeletedRoom) {
	const event = { type: "deleted", id: messageId } as const;
	if (room.group_id) await broadcast(env, "group", room.group_id, event, room.user_id);
	else if (room.connection_id) await broadcast(env, "dm", room.connection_id, event, room.user_id);
}
