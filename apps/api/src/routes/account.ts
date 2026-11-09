/**
 * Phase 7 (store readiness): in-app account deletion (App Store guideline
 * 5.1.1(v), Google Play's account deletion requirement).
 *
 * POST /me/delete {confirm: "DELETE"} → 200 {ok: true}, session cookie cleared.
 *
 * Deleted: everything the user made in Budgetrip (trip requests, plans,
 * packages and their items, saved trips, share links, price alerts), push
 * devices, notification preferences and throttles, pending native sign-in
 * codes, blocks either way, group memberships; open connections are closed.
 * Their messages are soft-deleted and their text replaced, EXCEPT a message
 * someone reported, whose text is kept for moderation.
 *
 * Kept: the users row as a tombstone (every personal field cleared, shown to
 * others as "Deleted user"), reports by and against the user, and the
 * Tagalong suspension marker (so a suspension's record survives).
 *
 * One D1 batch (a single transaction), so an interrupted request either did
 * all of it or nothing, and a retry by a still-signed-in user just runs it
 * again. Every statement is idempotent. The Apple token is revoked first, best
 * effort: a failure is logged and the deletion still happens.
 */
import { DeleteAccountRequestSchema } from "@tagalong/shared";
import { Hono } from "hono";
import { decryptRefreshToken, revokeApple } from "../auth/apple.js";
import { endSession, requireUser } from "../auth/session.js";
import { deferOf } from "../chat/notify.js";
import { HttpError, nowIso, readJson, type AppEnv } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { requireTrustedWrite } from "../lib/security.js";
import { leaveTagalong } from "../tagalong/leave.js";

export const account = new Hono<AppEnv>();

/** What a deleted user's unreported messages say from now on (and what moderators see). */
export const DELETED_MESSAGE_BODY = "[message deleted]";
/** The tombstone's display_name. */
export const DELETED_USER_NAME = "Deleted user";

account.post("/me/delete", requireTrustedWrite, requireUser, async (c) => {
	const userId = c.get("userId");
	const db = c.env.DB;
	await rateLimit(db, `account:delete:${userId}`, 5, 3600);
	const body = DeleteAccountRequestSchema.safeParse(await readJson(c));
	if (!body.success)
		throw new HttpError(400, "invalid", "Type DELETE to confirm.", body.error.issues);

	// Revoke Sign in with Apple first (best effort; never blocks deletion).
	const row = await db
		.prepare("SELECT apple_refresh_token_enc AS rt FROM users WHERE id = ?")
		.bind(userId)
		.first<{ rt: string | null }>();
	if (row?.rt) {
		const token = await decryptRefreshToken(c.env, row.rt);
		const revoked = token ? await revokeApple(c.env, token) : false;
		if (!revoked) console.warn("account delete: Apple token not revoked", { userId });
	}

	const now = nowIso();
	// The user's plans and trip requests, as subqueries (a statement sees the
	// rows earlier statements in the batch left).
	const myPlans = "SELECT id FROM plans WHERE user_id = ?";
	const myTrips = "SELECT id FROM trip_requests WHERE user_id = ?";
	const del = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds);

	await leaveTagalong(
		c.env,
		deferOf(c),
		userId,
		now,
		// The tombstone. google_sub gets a sentinel (it is NOT NULL UNIQUE), and
		// apple_sub is cleared so the same Apple ID signs in to a new account.
		db
			.prepare(
				`UPDATE users SET deleted_at = ?, google_sub = 'deleted:' || id, email = '',
				   display_name = ?, home_city = NULL, home_lat = NULL, home_lng = NULL,
				   home_currency = NULL, birthdate_verified_18 = 0, age_confirmed_at = NULL,
				   tagalong_opt_in_at = NULL, tagalong_name = NULL, tagalong_city = NULL,
				   tagalong_safety_ack_at = NULL, tagalong_trusted_at = NULL,
				   apple_sub = NULL, apple_refresh_token_enc = NULL
				 WHERE id = ? AND deleted_at IS NULL`,
			)
			.bind(now, DELETED_USER_NAME, userId),
		[
			// Messages: soft-deleted; text replaced unless a report points at it.
			db
				.prepare(
					`UPDATE messages SET deleted_at = COALESCE(deleted_at, ?),
					   deleted_by = COALESCE(deleted_by, 'author'),
					   body = CASE WHEN EXISTS (SELECT 1 FROM reports r
					     WHERE r.target_type = 'message' AND r.target_id = messages.id)
					     THEN body ELSE ? END
					 WHERE user_id = ?`,
				)
				.bind(now, DELETED_MESSAGE_BODY, userId),
			del("DELETE FROM native_auth_codes WHERE user_id = ?", userId),
			del("DELETE FROM push_devices WHERE user_id = ?", userId),
			del("DELETE FROM push_throttle WHERE user_id = ?", userId),
			del("DELETE FROM notification_prefs WHERE user_id = ?", userId),
			// Children before parents (D1 enforces foreign keys).
			del(
				`DELETE FROM price_alerts WHERE user_id = ? OR plan_id IN (${myPlans})
				   OR trip_request_id IN (${myTrips})`,
				userId,
				userId,
				userId,
			),
			del(`DELETE FROM share_links WHERE user_id = ? OR plan_id IN (${myPlans})`, userId, userId),
			del(
				`DELETE FROM saved_trips WHERE user_id = ? OR plan_id IN (${myPlans})
				   OR latest_plan_id IN (${myPlans}) OR trip_request_id IN (${myTrips})`,
				userId,
				userId,
				userId,
				userId,
			),
			del(
				`DELETE FROM package_items WHERE package_id IN
				   (SELECT id FROM packages WHERE plan_id IN (${myPlans}))`,
				userId,
			),
			del(`DELETE FROM packages WHERE plan_id IN (${myPlans})`, userId),
			del(`DELETE FROM plans WHERE user_id = ? OR trip_request_id IN (${myTrips})`, userId, userId),
			del("DELETE FROM trip_requests WHERE user_id = ?", userId),
			del("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?", userId, userId),
		],
	);

	endSession(c);
	return c.json({ ok: true });
});
