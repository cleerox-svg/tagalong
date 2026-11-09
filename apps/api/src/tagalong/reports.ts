/**
 * Reports and the moderation queue (BUILD_SPEC §6). A user may only report
 * what they can see: a message in a room they are in (a group they belong to,
 * or a connection they are party to), or a user they share a group or a
 * connection with. One report per reporter per target.
 *
 * Moderators see the reporter's and the target's Tagalong name and city only,
 * never an email or home location.
 */
import type {
	ModAction,
	ModReport,
	ReportInput,
	ReportReason,
	ReportResolution,
	ReportTargetType,
	RoomKind,
	MessageDeletedBy,
} from "@tagalong/shared";
import type { Defer } from "../chat/notify.js";
import { HttpError, newId, nowIso } from "../lib/http.js";
import { loadConnectionByPair, shareAGroup, SHOWN_NAME } from "./access.js";
import { leaveTagalong } from "./leave.js";
import { broadcastDeleted, type DeletedRoom } from "./messages.js";

async function canSeeMessage(db: D1Database, messageId: string, me: string) {
	return db
		.prepare(
			`SELECT m.user_id FROM messages m WHERE m.id = ? AND (
			   (m.group_id IS NOT NULL AND EXISTS (
			     SELECT 1 FROM group_members g WHERE g.group_id = m.group_id AND g.user_id = ?))
			   OR (m.connection_id IS NOT NULL AND EXISTS (
			     SELECT 1 FROM connections c WHERE c.id = m.connection_id AND (c.user_lo = ? OR c.user_hi = ?))))`,
		)
		.bind(messageId, me, me, me)
		.first<{ user_id: string }>();
}

/**
 * Files a report. Returns true when it is new, false when this reporter had
 * already reported this target (the duplicate is ignored).
 */
export async function createReport(db: D1Database, me: string, input: ReportInput) {
	if (input.target_type === "message") {
		const msg = await canSeeMessage(db, input.target_id, me);
		if (!msg) throw new HttpError(404, "not_found", "No such message.");
		if (msg.user_id === me)
			throw new HttpError(400, "invalid", "You can't report your own message.");
	} else {
		if (input.target_id === me) throw new HttpError(400, "invalid", "You can't report yourself.");
		const visible =
			(await shareAGroup(db, me, input.target_id)) ||
			(await loadConnectionByPair(db, me, input.target_id)) !== null;
		if (!visible) throw new HttpError(404, "not_found", "No such user.");
	}
	const res = await db
		.prepare(
			`INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (reporter_id, target_type, target_id) DO NOTHING`,
		)
		.bind(
			newId(),
			me,
			input.target_type,
			input.target_id,
			input.reason,
			input.details ?? null,
			nowIso(),
		)
		.run();
	return res.meta.changes > 0;
}

interface ReportRow {
	id: string;
	target_type: ReportTargetType;
	target_id: string;
	reason: ReportReason;
	details: string | null;
	created_at: string;
	resolved_at: string | null;
	resolved_by: string | null;
	resolution: ReportResolution | null;
	reporter_id: string;
	reporter_name: string | null;
	m_id: string | null;
	m_body: string | null;
	m_group_id: string | null;
	m_connection_id: string | null;
	m_author_id: string | null;
	m_created_at: string | null;
	m_deleted_at: string | null;
	m_deleted_by: MessageDeletedBy | null;
	t_id: string | null;
	t_name: string | null;
	t_city: string | null;
	t_suspended_at: string | null;
}

const REPORT_SELECT = `SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.created_at,
	  r.resolved_at, r.resolved_by, r.resolution,
	  r.reporter_id, ${SHOWN_NAME("ru")} AS reporter_name,
	  m.id AS m_id, m.body AS m_body, m.group_id AS m_group_id, m.connection_id AS m_connection_id,
	  m.user_id AS m_author_id, m.created_at AS m_created_at, m.deleted_at AS m_deleted_at,
	  m.deleted_by AS m_deleted_by,
	  tu.id AS t_id, ${SHOWN_NAME("tu")} AS t_name, tu.tagalong_city AS t_city,
	  tu.tagalong_suspended_at AS t_suspended_at
	FROM reports r
	JOIN users ru ON ru.id = r.reporter_id
	LEFT JOIN messages m ON r.target_type = 'message' AND m.id = r.target_id
	LEFT JOIN users tu ON tu.id = CASE WHEN r.target_type = 'user' THEN r.target_id ELSE m.user_id END`;

function toModReport(r: ReportRow): ModReport {
	const roomKind: RoomKind = r.m_group_id ? "group" : "dm";
	return {
		id: r.id,
		target_type: r.target_type,
		target_id: r.target_id,
		reason: r.reason,
		details: r.details,
		created_at: r.created_at,
		resolved_at: r.resolved_at,
		resolved_by: r.resolved_by,
		resolution: r.resolution,
		reporter: { user_id: r.reporter_id, name: r.reporter_name },
		message:
			r.m_id && r.m_author_id && r.m_body !== null && r.m_created_at
				? {
						id: r.m_id,
						body: r.m_body,
						room_kind: roomKind,
						room_id: (r.m_group_id ?? r.m_connection_id) as string,
						author_id: r.m_author_id,
						author_name: r.t_name,
						created_at: r.m_created_at,
						deleted_at: r.m_deleted_at,
						deleted_by: r.m_deleted_by,
					}
				: null,
		target_user: r.t_id
			? {
					user_id: r.t_id,
					name: r.t_name,
					city: r.t_city,
					suspended: r.t_suspended_at !== null,
				}
			: null,
	};
}

export const REPORT_PAGE = 200;

/** Open reports oldest first; resolved ones newest first. */
export async function listReports(
	db: D1Database,
	status: "open" | "resolved",
): Promise<ModReport[]> {
	const sql =
		status === "open"
			? `${REPORT_SELECT} WHERE r.resolved_at IS NULL ORDER BY r.created_at ASC, r.id LIMIT ?`
			: `${REPORT_SELECT} WHERE r.resolved_at IS NOT NULL ORDER BY r.resolved_at DESC, r.id LIMIT ?`;
	const { results } = await db.prepare(sql).bind(REPORT_PAGE).all<ReportRow>();
	return results.map(toModReport);
}

export async function loadReport(db: D1Database, id: string): Promise<ModReport | null> {
	const row = await db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).bind(id).first<ReportRow>();
	return row ? toModReport(row) : null;
}

/**
 * Applies a moderator's decision. Removing a message or suspending a user also
 * resolves every other open report about the same target; a suspension also
 * resolves the open reports about that user's messages. A message already
 * deleted by its author keeps deleted_by = 'author' and its deleted_at.
 */
export async function resolveReport(
	env: Env,
	defer: Defer,
	reportId: string,
	moderatorId: string,
	action: ModAction,
): Promise<ModReport> {
	const db = env.DB;
	const report = await loadReport(db, reportId);
	if (!report) throw new HttpError(404, "not_found", "No such report.");
	if (report.resolved_at)
		throw new HttpError(409, "already_resolved", "This report has already been resolved.");
	const now = nowIso();

	if (action === "dismiss") {
		await db
			.prepare(
				`UPDATE reports SET resolved_at = ?, resolved_by = ?, resolution = 'dismissed'
				 WHERE id = ? AND resolved_at IS NULL`,
			)
			.bind(now, moderatorId, reportId)
			.run();
	} else if (action === "remove_message") {
		if (report.target_type !== "message" || !report.message)
			throw new HttpError(400, "invalid_action", "Only a reported message can be removed.");
		const [removed] = await db.batch([
			db
				.prepare(
					`UPDATE messages SET deleted_at = COALESCE(deleted_at, ?),
					   deleted_by = COALESCE(deleted_by, 'moderator')
					 WHERE id = ? RETURNING group_id, connection_id, user_id`,
				)
				.bind(now, report.target_id),
			db
				.prepare(
					`UPDATE reports SET resolved_at = ?, resolved_by = ?, resolution = 'message_removed'
					 WHERE target_type = 'message' AND target_id = ? AND resolved_at IS NULL`,
				)
				.bind(now, moderatorId, report.target_id),
		]);
		const room = (removed?.results as DeletedRoom[] | undefined)?.[0];
		if (room) defer(broadcastDeleted(env, report.target_id, room));
	} else {
		const userId = report.target_user?.user_id;
		if (!userId) throw new HttpError(400, "invalid_action", "There is no user to suspend.");
		await suspendUser(env, defer, userId, now, [
			db
				.prepare(
					`UPDATE reports SET resolved_at = ?, resolved_by = ?, resolution = 'user_suspended'
					 WHERE id = ? AND resolved_at IS NULL`,
				)
				.bind(now, moderatorId, reportId),
			db
				.prepare(
					`UPDATE reports SET resolved_at = ?, resolved_by = ?, resolution = 'user_suspended'
					 WHERE target_type = 'user' AND target_id = ? AND resolved_at IS NULL`,
				)
				.bind(now, moderatorId, userId),
			// Open reports about any of the user's messages are settled by the suspension too.
			db
				.prepare(
					`UPDATE reports SET resolved_at = ?, resolved_by = ?, resolution = 'user_suspended'
					 WHERE target_type = 'message' AND resolved_at IS NULL
					   AND target_id IN (SELECT id FROM messages WHERE user_id = ?)`,
				)
				.bind(now, moderatorId, userId),
		]);
	}
	const updated = await loadReport(db, reportId);
	if (!updated) throw new HttpError(404, "not_found", "No such report.");
	return updated;
}

/**
 * Suspends Tagalong access: removes every group membership, closes every
 * open connection, and closes the user's sockets in all of those rooms.
 * Messages stay (soft-delete is a separate decision).
 */
export async function suspendUser(
	env: Env,
	defer: Defer,
	userId: string,
	now: string,
	extra: D1PreparedStatement[] = [],
) {
	await leaveTagalong(
		env,
		defer,
		userId,
		now,
		env.DB.prepare(
			"UPDATE users SET tagalong_suspended_at = COALESCE(tagalong_suspended_at, ?) WHERE id = ?",
		).bind(now, userId),
		extra,
	);
}

export async function trustUser(db: D1Database, userId: string) {
	const res = await db
		.prepare("UPDATE users SET tagalong_trusted_at = COALESCE(tagalong_trusted_at, ?) WHERE id = ?")
		.bind(nowIso(), userId)
		.run();
	if (!res.meta.changes) throw new HttpError(404, "not_found", "No such user.");
}
