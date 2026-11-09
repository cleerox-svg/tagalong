/**
 * Phase 6 (spec §9): push device registration and notification preferences.
 *
 * A device token belongs to one user at a time: registering a token that is
 * already known moves it to the caller (a shared phone that changed account).
 * Unregistering only ever touches the caller's own row and answers 204 either
 * way, so it can't be used to probe whether a token exists.
 */
import { Hono } from "hono";
import {
	DEFAULT_NOTIFICATION_PREFS,
	NOTIFICATION_KINDS,
	NotificationPrefsUpdateSchema,
	RegisterDeviceSchema,
	UnregisterDeviceSchema,
	type NotificationPrefs,
} from "@tagalong/shared";
import { requireUser } from "../auth/session.js";
import { invalidInput, newId, nowIso, readJson, type AppEnv } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { requireTrustedWrite } from "../lib/security.js";

export const push = new Hono<AppEnv>();

const signedIn = [requireTrustedWrite, requireUser] as const;

/** Active (not disabled) devices kept per user; registering an 11th disables the stalest. */
export const MAX_ACTIVE_DEVICES = 10;

push.post("/push/devices", ...signedIn, async (c) => {
	const me = c.get("userId");
	const body = RegisterDeviceSchema.safeParse(await readJson(c));
	if (!body.success) throw invalidInput(body.error.issues, "Send { platform, token }.");
	await rateLimit(c.env.DB, `push-device:${me}`, 30, 3600);
	const now = nowIso();
	await c.env.DB.batch([
		c.env.DB.prepare(
			`INSERT INTO push_devices (id, user_id, platform, token, created_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id,
			   platform = excluded.platform, last_seen_at = excluded.last_seen_at,
			   disabled_at = NULL, last_error = NULL`,
		).bind(newId(), me, body.data.platform, body.data.token, now, now),
		c.env.DB.prepare(
			`UPDATE push_devices SET disabled_at = ?, last_error = 'device_limit'
			 WHERE user_id = ? AND disabled_at IS NULL AND id NOT IN (
			   SELECT id FROM push_devices WHERE user_id = ? AND disabled_at IS NULL
			   ORDER BY last_seen_at DESC, id DESC LIMIT ?)`,
		).bind(now, me, me, MAX_ACTIVE_DEVICES),
	]);
	return c.body(null, 204);
});

push.post("/push/devices/unregister", ...signedIn, async (c) => {
	const body = UnregisterDeviceSchema.safeParse(await readJson(c));
	if (!body.success) throw invalidInput(body.error.issues, "Send { token }.");
	await c.env.DB.prepare("DELETE FROM push_devices WHERE token = ? AND user_id = ?")
		.bind(body.data.token, c.get("userId"))
		.run();
	return c.body(null, 204);
});

type PrefsRow = Record<keyof NotificationPrefs, number>;

// Column names come from the fixed NOTIFICATION_KINDS list, never from input.
const PREF_COLUMNS = NOTIFICATION_KINDS.join(", ");
/** `kind = COALESCE(?, current)` per kind: a NULL bind keeps the stored value. */
const PREF_UPDATES = NOTIFICATION_KINDS.map((k) => `${k} = COALESCE(?, notification_prefs.${k})`).join(
	", ",
);

const toPrefs = (row: PrefsRow | null): NotificationPrefs =>
	row
		? {
				dm: row.dm === 1,
				group_message: row.group_message === 1,
				connection_request: row.connection_request === 1,
				connection_accepted: row.connection_accepted === 1,
				price_drop: row.price_drop === 1,
			}
		: { ...DEFAULT_NOTIFICATION_PREFS };

/** The user's push preferences, or the defaults when they never changed any. */
export async function loadPrefs(db: D1Database, userId: string): Promise<NotificationPrefs> {
	const row = await db
		.prepare(`SELECT ${PREF_COLUMNS} FROM notification_prefs WHERE user_id = ?`)
		.bind(userId)
		.first<PrefsRow>();
	return toPrefs(row);
}

push.get("/me/notifications", requireUser, async (c) => {
	return c.json(await loadPrefs(c.env.DB, c.get("userId")));
});

/** Partial update: only the toggles sent change; a first write starts from the defaults. */
push.post("/me/notifications", ...signedIn, async (c) => {
	const body = NotificationPrefsUpdateSchema.safeParse(await readJson(c));
	if (!body.success) throw invalidInput(body.error.issues, "Send one or more on/off toggles.");
	const u = body.data;
	const bit = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
	const insertBits = NOTIFICATION_KINDS.map((k) => bit(u[k] ?? DEFAULT_NOTIFICATION_PREFS[k]));
	const updateBits = NOTIFICATION_KINDS.map((k) => bit(u[k]));
	const row = await c.env.DB.prepare(
		`INSERT INTO notification_prefs (user_id, ${PREF_COLUMNS}, updated_at)
		 VALUES (?, ${NOTIFICATION_KINDS.map(() => "?").join(", ")}, ?)
		 ON CONFLICT (user_id) DO UPDATE SET ${PREF_UPDATES}, updated_at = excluded.updated_at
		 RETURNING ${PREF_COLUMNS}`,
	)
		.bind(c.get("userId"), ...insertBits, nowIso(), ...updateBits)
		.first<PrefsRow>();
	return c.json(toPrefs(row));
});
