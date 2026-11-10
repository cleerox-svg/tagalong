/**
 * Tagalong access rules (BUILD_SPEC §6): who may use Tagalong, who can see
 * whom, and who moderates. Every check is a scoped, prepared query.
 *
 * Privacy: nothing here ever selects email, home_city, home_lat or home_lng.
 * Other users are only ever shown by tagalong_name and tagalong_city.
 */
import type { TagalongStatus } from "@tagalong/shared";
import { createMiddleware } from "hono/factory";
import { requireAdult, requireUser } from "../auth/session.js";
import { HttpError } from "../lib/http.js";
import { requireTrustedWrite } from "../lib/security.js";

/** The session user's Tagalong state, loaded once per request by requireTagalong. */
export interface TagalongUser {
	id: string;
	name: string;
	city: string;
	created_at: string;
	safety_acked: boolean;
	trusted: boolean;
}

export type TgEnv = { Bindings: Env; Variables: { userId: string; tg: TagalongUser } };

/** An account counts as trusted after this long, or once a moderator trusts it. */
export const TRUST_AFTER_DAYS = 7;

export interface TagalongRow {
	created_at: string;
	tagalong_opt_in_at: string | null;
	tagalong_name: string | null;
	tagalong_city: string | null;
	tagalong_safety_ack_at: string | null;
	tagalong_trusted_at: string | null;
	tagalong_suspended_at: string | null;
}

/** Column list for TagalongRow. Never add email or home_* here. */
export const TAGALONG_COLUMNS = `created_at, tagalong_opt_in_at, tagalong_name, tagalong_city,
	tagalong_safety_ack_at, tagalong_trusted_at, tagalong_suspended_at`;

export function isTrusted(row: Pick<TagalongRow, "created_at" | "tagalong_trusted_at">): boolean {
	if (row.tagalong_trusted_at) return true;
	const created = Date.parse(row.created_at);
	// An unreadable timestamp is treated as a new account (the stricter limits).
	if (!Number.isFinite(created)) return false;
	return Date.now() - created >= TRUST_AFTER_DAYS * 86400_000;
}

export function tagalongStatus(row: TagalongRow): TagalongStatus {
	return {
		opted_in: row.tagalong_opt_in_at !== null,
		name: row.tagalong_name,
		city: row.tagalong_city,
		safety_acked: row.tagalong_safety_ack_at !== null,
		trusted: isTrusted(row),
		suspended: row.tagalong_suspended_at !== null,
	};
}

export async function loadTagalongRow(db: D1Database, userId: string): Promise<TagalongRow | null> {
	return db
		.prepare(`SELECT ${TAGALONG_COLUMNS} FROM users WHERE id = ?`)
		.bind(userId)
		.first<TagalongRow>();
}

/**
 * Opted in and not suspended. Run after requireUser and requireAdult. Sets
 * c.get("tg").
 */
export const requireTagalong = createMiddleware<TgEnv>(async (c, next) => {
	const row = await loadTagalongRow(c.env.DB, c.get("userId"));
	if (!row) throw new HttpError(401, "signed_out", "Sign in first.");
	if (row.tagalong_suspended_at)
		throw new HttpError(403, "tagalong_suspended", "Your Tagalong access has been suspended.");
	if (!row.tagalong_opt_in_at || !row.tagalong_name || !row.tagalong_city)
		throw new HttpError(403, "tagalong_opt_in_required", "Turn on Tagalong first.");
	c.set("tg", {
		id: c.get("userId"),
		name: row.tagalong_name,
		city: row.tagalong_city,
		created_at: row.created_at,
		safety_acked: row.tagalong_safety_ack_at !== null,
		trusted: isTrusted(row),
	});
	return next();
});

/** Route middleware: CSRF/origin check, signed in, 18+. */
export const adult = [requireTrustedWrite, requireUser, requireAdult] as const;
/** As `adult`, plus opted in to Tagalong and not suspended. */
export const member = [...adult, requireTagalong] as const;

// ---------------------------------------------------------------------------
// Moderators
// ---------------------------------------------------------------------------

/** MODERATOR_USER_IDS, read per request. Empty or missing means nobody. */
export function moderatorIds(env: Env): string[] {
	// wrangler types the var as the literal "" from wrangler.jsonc; widen it.
	return String(env.MODERATOR_USER_IDS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export const isModerator = (env: Env, userId: string) => moderatorIds(env).includes(userId);

/** Run after requireUser. Fails closed when the list is empty. */
export const requireModerator = createMiddleware<TgEnv>(async (c, next) => {
	if (!isModerator(c.env, c.get("userId")))
		throw new HttpError(403, "not_moderator", "Only moderators can open this.");
	return next();
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * SQL: the name other people see for the user aliased `alias`. A deleted
 * account (phase 7) is always "Deleted user"; its old name is gone anyway.
 */
export const SHOWN_NAME = (alias: string) =>
	`CASE WHEN ${alias}.deleted_at IS NOT NULL THEN 'Deleted user' ELSE ${alias}.tagalong_name END`;

/** SQL fragment: true when `?` (me) and the given column's user block each other either way. */
export const NOT_BLOCKED = (col: string) =>
	`NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = ${col})
		OR (b.blocker_id = ${col} AND b.blocked_id = ?))`;

export async function isBlockedEitherWay(db: D1Database, a: string, b: string): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?)
			 OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`,
		)
		.bind(a, b, b, a)
		.first();
	return row !== null;
}

/**
 * The user owns a plan for this event: the plan's resolved event, or the event
 * of one of its packages (an alternative date). This is how a group is found.
 */
export async function canSeeEvent(db: D1Database, userId: string, eventId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS x FROM plans p WHERE p.user_id = ? AND (p.event_id = ?
			   OR EXISTS (SELECT 1 FROM packages k WHERE k.plan_id = p.id AND k.event_id = ?))
			 LIMIT 1`,
		)
		.bind(userId, eventId, eventId)
		.first();
	return row !== null;
}

export async function isGroupMember(db: D1Database, groupId: string, userId: string) {
	const row = await db
		.prepare("SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?")
		.bind(groupId, userId)
		.first();
	return row !== null;
}

/** 404 unless the user is in the group. */
export async function requireMember(db: D1Database, groupId: string, userId: string) {
	if (!(await isGroupMember(db, groupId, userId)))
		throw new HttpError(404, "not_found", "No such group.");
}

export interface ConnectionRow {
	id: string;
	user_lo: string;
	user_hi: string;
	requested_by: string;
	status: "pending" | "accepted" | "declined" | "closed";
	created_at: string;
	responded_at: string | null;
	/** Who closed it (0007); null when open, declined, or closed before 0007. */
	closed_by: string | null;
}

export const CONNECTION_ROW_COLUMNS =
	"id, user_lo, user_hi, requested_by, status, created_at, responded_at, closed_by";

/** The pair key for connections: [user_lo, user_hi]. */
export const pairOf = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export const otherParty = (conn: ConnectionRow, me: string) =>
	conn.user_lo === me ? conn.user_hi : conn.user_lo;

/** A connection the user is a party to, else null. */
export async function loadConnection(
	db: D1Database,
	connectionId: string,
	userId: string,
): Promise<ConnectionRow | null> {
	return db
		.prepare(
			`SELECT ${CONNECTION_ROW_COLUMNS}
			 FROM connections WHERE id = ? AND (user_lo = ? OR user_hi = ?)`,
		)
		.bind(connectionId, userId, userId)
		.first<ConnectionRow>();
}

/** The connection between two users, whichever side asked, else null. */
export async function loadConnectionByPair(
	db: D1Database,
	a: string,
	b: string,
): Promise<ConnectionRow | null> {
	const [lo, hi] = pairOf(a, b);
	return db
		.prepare(`SELECT ${CONNECTION_ROW_COLUMNS} FROM connections WHERE user_lo = ? AND user_hi = ?`)
		.bind(lo, hi)
		.first<ConnectionRow>();
}

/**
 * A DM room: the user is a party, the connection is accepted, and neither
 * side has blocked the other. Anything else is a 404.
 */
export async function requireDm(
	db: D1Database,
	connectionId: string,
	userId: string,
): Promise<ConnectionRow> {
	const conn = await loadConnection(db, connectionId, userId);
	if (
		!conn ||
		conn.status !== "accepted" ||
		(await isBlockedEitherWay(db, userId, otherParty(conn, userId)))
	)
		throw new HttpError(404, "not_found", "No such conversation.");
	return conn;
}

/** The other user is opted in and not suspended. */
export async function isActiveTagalongUser(db: D1Database, userId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS x FROM users WHERE id = ? AND tagalong_opt_in_at IS NOT NULL
			 AND tagalong_suspended_at IS NULL AND birthdate_verified_18 = 1
			 AND deleted_at IS NULL`,
		)
		.bind(userId)
		.first();
	return row !== null;
}

export async function shareAGroup(db: D1Database, a: string, b: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS x FROM group_members g1 JOIN group_members g2 ON g2.group_id = g1.group_id
			 WHERE g1.user_id = ? AND g2.user_id = ? LIMIT 1`,
		)
		.bind(a, b)
		.first();
	return row !== null;
}
