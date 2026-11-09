/**
 * Phase 6 (spec §9): who gets a push notification, and what it says.
 *
 * Every rule is applied when the push is sent, not when the event happened,
 * so a block, an opt-out or a suspension that lands in between still counts:
 *
 * - Nothing at all (not even a D1 read) unless FCM is configured.
 * - Never the author/actor. Preferences per kind (defaults when no row).
 * - Tagalong kinds: the recipient is opted in, not suspended, 18+, and not in
 *   a block relation with the author either way (chat/notify.ts roomAudience
 *   plus the same users-table checks as tagalong/access.ts). DMs only on an
 *   accepted connection; groups only to current members.
 * - One push per user per room per THROTTLE_MS (push_throttle, claimed
 *   atomically). At most MAX_SENDS device sends per event.
 * - Privacy: never a message body, a location or an email. Titles and bodies
 *   carry only a Tagalong display name, an event name or a stored price.
 * - Price drops: the figure is the stored price_alerts row (integer minor
 *   units + currency) through formatMoney, never recomputed.
 *
 * Nothing here throws: a failure is logged and recorded on the device row.
 */
import { formatMoney, isSafeAppPath, type Connection, type RoomKind } from "@tagalong/shared";
import { DEFAULT_NOTIFICATION_PREFS, type NotificationKind } from "@tagalong/shared";
import { roomAudience, type Defer } from "../chat/notify.js";
import { nowIso } from "../lib/http.js";
import { isPushConfigured, sendPush, type PushResult } from "../providers/fcm.js";

export type PushEvent =
	/** A message was stored in a DM (connectionId is the room id). */
	| { kind: "dm"; authorId: string; connectionId: string }
	/** A message was stored in an event group. */
	| { kind: "group_message"; authorId: string; groupId: string }
	/** fromUserId asked toUserId to connect (the connection is pending). */
	| { kind: "connection_request"; connectionId: string; fromUserId: string; toUserId: string }
	/** fromUserId accepted toUserId's request (the connection is accepted). */
	| { kind: "connection_accepted"; connectionId: string; fromUserId: string; toUserId: string }
	/** A price_alerts row was written; the owner hears about it. */
	| { kind: "price_drop"; alertId: string };

/** One push per user per room in this window: a busy chat doesn't buzz on every message. */
export const THROTTLE_MS = 5 * 60_000;
/** Recipients considered per event. */
export const MAX_RECIPIENTS = 50;
/** Newest active devices tried per recipient. */
export const MAX_DEVICES_PER_RECIPIENT = 3;
/** Device sends per event, in total (bounds subrequests). */
export const MAX_SENDS = 50;
/** Names in a notification are cut to this many characters. */
const NAME_MAX = 60;

const FALLBACK_NAME = "A Tagalong member";

/** Schedules a push for `event` after the response. Never throws; a null event is a no-op. */
export function notify(env: Env, defer: Defer, event: PushEvent | null): void {
	if (!event || !isPushConfigured(env)) return;
	defer(dispatchPush(env, event));
}

/** The message event for a room. */
export const messageEvent = (kind: RoomKind, roomId: string, authorId: string): PushEvent =>
	kind === "dm"
		? { kind: "dm", authorId, connectionId: roomId }
		: { kind: "group_message", authorId, groupId: roomId };

/**
 * The event for a connection `me` just acted on: a new pending request I made
 * is a request; an accepted one (I accepted, or asked back) is an acceptance.
 * Anything else (declined, closed, unchanged) sends nothing.
 */
export function connectionEvent(conn: Connection, me: string): PushEvent | null {
	const base = { connectionId: conn.id, fromUserId: me, toUserId: conn.other_user_id };
	if (conn.status === "pending" && conn.requested_by_me)
		return { kind: "connection_request", ...base };
	if (conn.status === "accepted" && !conn.requested_by_me)
		return { kind: "connection_accepted", ...base };
	return null;
}

interface Planned {
	kind: NotificationKind;
	/** The user whose action caused this: never notified, block relations excluded. Null for price drops. */
	actorId: string | null;
	candidates: string[];
	/** Tagalong safety gating applies (opted in, not suspended, 18+, no block). */
	tagalong: boolean;
	/** push_throttle key, or null for none. */
	roomKey: string | null;
	title: string;
	body: string;
	path: string;
}

const clip = (s: string) => {
	const t = s.trim().replace(/\s+/g, " ");
	return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t;
};

async function tagalongName(db: D1Database, userId: string): Promise<string> {
	const row = await db
		.prepare("SELECT tagalong_name AS name FROM users WHERE id = ?")
		.bind(userId)
		.first<{ name: string | null }>();
	return row?.name ? clip(row.name) : FALLBACK_NAME;
}

/** The connection, only if it is between exactly these two users and has this status. */
async function connectionIs(
	db: D1Database,
	id: string,
	a: string,
	b: string,
	status: "pending" | "accepted",
	requestedBy: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS x FROM connections WHERE id = ? AND status = ? AND requested_by = ?
			 AND ((user_lo = ? AND user_hi = ?) OR (user_lo = ? AND user_hi = ?))`,
		)
		.bind(id, status, requestedBy, a, b, b, a)
		.first();
	return row !== null;
}

async function plan(env: Env, event: PushEvent): Promise<Planned | null> {
	const db = env.DB;
	switch (event.kind) {
		case "dm": {
			// roomAudience: accepted, no block either way; else nobody.
			const { allow } = await roomAudience(db, "dm", event.connectionId, event.authorId);
			if (!allow.includes(event.authorId)) return null;
			return {
				kind: "dm",
				actorId: event.authorId,
				candidates: allow,
				tagalong: true,
				roomKey: `dm:${event.connectionId}`,
				title: "New message",
				body: `From ${await tagalongName(db, event.authorId)}`,
				path: `/dm/${event.connectionId}`,
			};
		}
		case "group_message": {
			// roomAudience: current members, opted in, not suspended, 18+; skip = blocked.
			const { allow, skip } = await roomAudience(db, "group", event.groupId, event.authorId);
			const group = await db
				.prepare(
					`SELECT e.name FROM event_groups g JOIN events e ON e.id = g.event_id WHERE g.id = ?`,
				)
				.bind(event.groupId)
				.first<{ name: string }>();
			if (!group) return null;
			return {
				kind: "group_message",
				actorId: event.authorId,
				candidates: allow.filter((id) => !skip.includes(id)),
				tagalong: true,
				roomKey: `group:${event.groupId}`,
				title: "New messages",
				body: `In the ${clip(group.name)} group`,
				path: `/groups/${event.groupId}`,
			};
		}
		case "connection_request":
		case "connection_accepted": {
			const pending = event.kind === "connection_request";
			// Still in the state this event describes: a request made by `from`,
			// or a request `to` made that is now accepted.
			const ok = await connectionIs(
				db,
				event.connectionId,
				event.fromUserId,
				event.toUserId,
				pending ? "pending" : "accepted",
				pending ? event.fromUserId : event.toUserId,
			);
			if (!ok) return null;
			const name = await tagalongName(db, event.fromUserId);
			return {
				kind: event.kind,
				actorId: event.fromUserId,
				candidates: [event.toUserId],
				tagalong: true,
				// Re-asking after a decline/close can't buzz someone repeatedly.
				roomKey: `${pending ? "connreq" : "connacc"}:${event.connectionId}`,
				title: pending ? "Connection request" : "Request accepted",
				body: pending ? `${name} wants to connect` : `${name} accepted your request`,
				path: "/connections",
			};
		}
		case "price_drop":
			return null; // handled by dispatchPriceDrop
	}
}

/**
 * Of `candidates`, who may get this push now: not the actor, the kind turned
 * on (or on by default), at least one active device, and for Tagalong kinds
 * opted in, not suspended, 18+ and no block either way with the actor.
 */
async function eligible(db: D1Database, p: Planned): Promise<string[]> {
	const ids = [...new Set(p.candidates)].filter((id) => id !== p.actorId);
	if (ids.length === 0) return [];
	const gate = p.tagalong
		? `AND u.tagalong_opt_in_at IS NOT NULL AND u.tagalong_suspended_at IS NULL
		   AND u.birthdate_verified_18 = 1
		   AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ?1 AND b.blocked_id = u.id)
		     OR (b.blocker_id = u.id AND b.blocked_id = ?1))`
		: "";
	// p.kind is one of the fixed NOTIFICATION_KINDS, each a notification_prefs column.
	const { results } = await db
		.prepare(
			`SELECT u.id FROM users u LEFT JOIN notification_prefs np ON np.user_id = u.id
			 WHERE u.id IN (SELECT value FROM json_each(?2))
			   AND u.id IS NOT ?1
			   AND COALESCE(np.${p.kind}, ?3) = 1
			   AND EXISTS (SELECT 1 FROM push_devices d WHERE d.user_id = u.id AND d.disabled_at IS NULL)
			   ${gate}
			 ORDER BY u.id LIMIT ?4`,
		)
		.bind(p.actorId, JSON.stringify(ids), DEFAULT_NOTIFICATION_PREFS[p.kind] ? 1 : 0, MAX_RECIPIENTS)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/** Claims the throttle slot for each user atomically; returns only those who got it. */
async function claimThrottle(db: D1Database, userIds: string[], roomKey: string): Promise<string[]> {
	if (userIds.length === 0) return [];
	const now = Date.now();
	const { results } = await db
		.prepare(
			`INSERT INTO push_throttle (user_id, room_key, last_sent_at)
			 SELECT value, ?, ? FROM json_each(?) WHERE true
			 ON CONFLICT (user_id, room_key) DO UPDATE SET last_sent_at = excluded.last_sent_at
			 WHERE push_throttle.last_sent_at < ?
			 RETURNING user_id`,
		)
		.bind(
			roomKey,
			new Date(now).toISOString(),
			JSON.stringify(userIds),
			new Date(now - THROTTLE_MS).toISOString(),
		)
		.all<{ user_id: string }>();
	return results.map((r) => r.user_id);
}

interface Device {
	id: string;
	token: string;
}

/** Up to MAX_DEVICES_PER_RECIPIENT newest active devices each, MAX_SENDS in total, fairly spread. */
async function devicesOf(db: D1Database, userIds: string[]): Promise<Device[]> {
	if (userIds.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT id, token FROM (
			   SELECT id, user_id, token,
			     ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY last_seen_at DESC, id) AS rn
			   FROM push_devices
			   WHERE disabled_at IS NULL AND user_id IN (SELECT value FROM json_each(?)))
			 WHERE rn <= ? ORDER BY rn, user_id LIMIT ?`,
		)
		.bind(JSON.stringify(userIds), MAX_DEVICES_PER_RECIPIENT, MAX_SENDS)
		.all<Device>();
	return results;
}

/** Sends to each device and records dead tokens and failures. Returns the results. */
async function sendAll(
	env: Env,
	devices: Device[],
	msg: { kind: NotificationKind; title: string; body: string; path: string },
): Promise<PushResult[]> {
	const data = { kind: msg.kind, path: msg.path };
	const results = await Promise.all(
		devices.map((d) => sendPush(env, { token: d.token, title: msg.title, body: msg.body, data })),
	);
	const now = nowIso();
	const updates: D1PreparedStatement[] = [];
	results.forEach((r, i) => {
		const d = devices[i];
		if (!d) return;
		if (r.status === "invalid_token")
			updates.push(
				env.DB.prepare(
					"UPDATE push_devices SET disabled_at = ?, last_error = ? WHERE id = ? AND token = ?",
				).bind(now, r.detail.slice(0, 200), d.id, d.token),
			);
		else if (r.status === "retryable" || r.status === "error")
			updates.push(
				env.DB.prepare("UPDATE push_devices SET last_error = ? WHERE id = ? AND token = ?").bind(
					`${r.status}: ${r.detail}`.slice(0, 200),
					d.id,
					d.token,
				),
			);
	});
	if (updates.length > 0) await env.DB.batch(updates);
	return results;
}

async function dispatchPriceDrop(env: Env, alertId: string): Promise<void> {
	const db = env.DB;
	// Only an alert not yet pushed or failed: a retried cron run never pushes twice.
	const alert = await db
		.prepare(
			`SELECT a.user_id, a.plan_id, a.new_total_minor, a.currency,
			   COALESCE(e.name, t.event_query) AS name
			 FROM price_alerts a
			 JOIN trip_requests t ON t.id = a.trip_request_id
			 LEFT JOIN plans p ON p.id = a.plan_id
			 LEFT JOIN events e ON e.id = p.event_id
			 WHERE a.id = ? AND a.pushed_at IS NULL AND a.push_error IS NULL`,
		)
		.bind(alertId)
		.first<{
			user_id: string;
			plan_id: string;
			new_total_minor: number;
			currency: string;
			name: string;
		}>();
	if (!alert) return;
	// The stored integer minor units + currency, formatted; nothing recomputed.
	const price = formatMoney({ amount_minor: alert.new_total_minor, currency: alert.currency });
	const p: Planned = {
		kind: "price_drop",
		actorId: null,
		candidates: [alert.user_id],
		tagalong: false,
		roomKey: null,
		title: "Price drop",
		body: `${clip(alert.name)} is now ${price}`,
		path: `/plans/${alert.plan_id}`,
	};
	if (!isSafeAppPath(p.path)) return;
	const recipients = await eligible(db, p);
	const devices = await devicesOf(db, recipients);
	if (devices.length === 0) return;
	const results = await sendAll(env, devices, p);
	const failed = results.find((r) => r.status !== "ok" && r.status !== "disabled");
	if (results.some((r) => r.status === "ok"))
		await db
			.prepare("UPDATE price_alerts SET pushed_at = ? WHERE id = ?")
			.bind(nowIso(), alertId)
			.run();
	else if (failed && "detail" in failed)
		await db
			.prepare("UPDATE price_alerts SET push_error = ? WHERE id = ?")
			.bind(`${failed.status}: ${failed.detail}`.slice(0, 200), alertId)
			.run();
}

/** Works out recipients and sends. Never throws. */
export async function dispatchPush(env: Env, event: PushEvent): Promise<void> {
	if (!isPushConfigured(env)) return;
	try {
		if (event.kind === "price_drop") return await dispatchPriceDrop(env, event.alertId);
		const p = await plan(env, event);
		if (!p || !isSafeAppPath(p.path)) return;
		let recipients = await eligible(env.DB, p);
		if (p.roomKey) recipients = await claimThrottle(env.DB, recipients, p.roomKey);
		const devices = await devicesOf(env.DB, recipients);
		if (devices.length > 0) await sendAll(env, devices, p);
	} catch (err) {
		console.error("push dispatch failed", event.kind, err);
	}
}
