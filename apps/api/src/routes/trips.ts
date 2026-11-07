/**
 * Phase 3 (spec §9): saved trips, read-only share links, price-drop alerts.
 */
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/session.js";
import { HttpError, nowIso, readJson, type AppEnv } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { requireTrustedWrite } from "../lib/security.js";
import { newShareToken, SHARE_TOKEN_RE, shareUrl } from "../lib/share.js";
import { cheapestTotal, loadPlan } from "../planning/view.js";

export const trips = new Hono<AppEnv>();

const signedIn = [requireTrustedWrite, requireUser] as const;

async function ownedPlan(db: D1Database, planId: string, userId: string) {
	const row = await db
		.prepare(
			`SELECT p.id, p.trip_request_id, p.status, t.budget_currency
			 FROM plans p JOIN trip_requests t ON t.id = p.trip_request_id
			 WHERE p.id = ? AND p.user_id = ?`,
		)
		.bind(planId, userId)
		.first<{ id: string; trip_request_id: string; status: string; budget_currency: string }>();
	if (!row) throw new HttpError(404, "not_found", "No such plan.");
	return row;
}

/** Save a trip. Saving again (or saving a re-check of it) just points it at this plan. */
trips.post("/plans/:id/save", ...signedIn, async (c) => {
	const userId = c.get("userId");
	const plan = await ownedPlan(c.env.DB, c.req.param("id"), userId);
	if (plan.status !== "done")
		throw new HttpError(409, "not_ready", "Wait for the plan to finish first.");
	const best = await cheapestTotal(c.env.DB, plan.id);
	await c.env.DB.prepare(
		`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, best_total_minor, currency)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (user_id, trip_request_id) DO UPDATE SET
		   latest_plan_id = excluded.latest_plan_id,
		   best_total_minor = CASE
		     WHEN saved_trips.best_total_minor IS NULL THEN excluded.best_total_minor
		     WHEN excluded.best_total_minor IS NULL THEN saved_trips.best_total_minor
		     ELSE MIN(saved_trips.best_total_minor, excluded.best_total_minor) END`,
	)
		.bind(userId, plan.id, plan.trip_request_id, plan.id, best, plan.budget_currency)
		.run();
	return c.json({ saved: true });
});

trips.post("/plans/:id/unsave", ...signedIn, async (c) => {
	const userId = c.get("userId");
	const plan = await ownedPlan(c.env.DB, c.req.param("id"), userId);
	await c.env.DB.prepare("DELETE FROM saved_trips WHERE user_id = ? AND trip_request_id = ?")
		.bind(userId, plan.trip_request_id)
		.run();
	return c.json({ saved: false });
});

const AlertsBody = z.object({ enabled: z.boolean() });

trips.post("/plans/:id/alerts", ...signedIn, async (c) => {
	const userId = c.get("userId");
	const body = AlertsBody.safeParse(await readJson(c));
	if (!body.success) throw new HttpError(400, "invalid", "Send { enabled: true | false }.");
	const plan = await ownedPlan(c.env.DB, c.req.param("id"), userId);
	const res = await c.env.DB.prepare(
		"UPDATE saved_trips SET alerts_enabled = ? WHERE user_id = ? AND trip_request_id = ?",
	)
		.bind(body.data.enabled ? 1 : 0, userId, plan.trip_request_id)
		.run();
	if (!res.meta.changes) throw new HttpError(409, "not_saved", "Save the trip first.");
	return c.json({ alerts_enabled: body.data.enabled });
});

/** Saved state and active share link for one plan, for the plan page. */
trips.get("/plans/:id/saved", ...signedIn, async (c) => {
	const userId = c.get("userId");
	const plan = await ownedPlan(c.env.DB, c.req.param("id"), userId);
	const saved = await c.env.DB.prepare(
		"SELECT alerts_enabled, best_total_minor, currency FROM saved_trips WHERE user_id = ? AND trip_request_id = ?",
	)
		.bind(userId, plan.trip_request_id)
		.first<{ alerts_enabled: number; best_total_minor: number | null; currency: string }>();
	const share = await c.env.DB.prepare(
		"SELECT token FROM share_links WHERE plan_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
	)
		.bind(plan.id, userId)
		.first<{ token: string }>();
	return c.json({
		saved: Boolean(saved),
		alerts_enabled: saved ? saved.alerts_enabled === 1 : false,
		share_url: share ? shareUrl(share.token) : null,
	});
});

/**
 * My trips: saved trips with their newest plan. Each trip carries its event's
 * Tagalong group, `{ group_id, member_count, joined }` (group_id null and
 * count 0 when nobody has opened one yet), or null when the plan has no
 * event; computed in this one query, not per trip.
 */
trips.get("/trips", ...signedIn, async (c) => {
	const userId = c.get("userId");
	const { results } = await c.env.DB.prepare(
		`SELECT s.latest_plan_id AS plan_id, s.alerts_enabled, s.best_total_minor, s.currency, s.last_checked_at,
		   s.created_at AS saved_at, t.event_query, t.origin_city, t.party_size, t.budget_minor, t.budget_scope,
		   p.event_id, e.name AS event_name, e.local_date, e.venue_name, e.city AS event_city, p.status,
		   g.id AS g_id,
		   (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS g_member_count,
		   EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = s.user_id)
		     AS g_joined
		 FROM saved_trips s
		 JOIN trip_requests t ON t.id = s.trip_request_id
		 JOIN plans p ON p.id = s.latest_plan_id AND p.user_id = s.user_id
		 LEFT JOIN events e ON e.id = p.event_id
		 LEFT JOIN event_groups g ON g.event_id = p.event_id
		 WHERE s.user_id = ?
		 ORDER BY COALESCE(e.local_date, t.date_from)`,
	)
		.bind(userId)
		.all<
			Record<string, unknown> & {
				event_id: string | null;
				g_id: string | null;
				g_member_count: number;
				g_joined: number;
			}
		>();
	const { results: alerts } = await c.env.DB.prepare(
		`SELECT a.trip_request_id, a.plan_id, a.old_total_minor, a.new_total_minor, a.currency, a.created_at, a.emailed_at
		 FROM price_alerts a WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 20`,
	)
		.bind(userId)
		.all();
	return c.json({
		trips: results.map(({ g_id, g_member_count, g_joined, ...r }) => ({
			...r,
			alerts_enabled: r.alerts_enabled === 1,
			group: r.event_id
				? { group_id: g_id, member_count: g_id ? g_member_count : 0, joined: g_joined === 1 }
				: null,
		})),
		alerts,
	});
});

/** Create (or return the existing) read-only link for a plan. */
trips.post("/plans/:id/share", ...signedIn, async (c) => {
	const userId = c.get("userId");
	const plan = await ownedPlan(c.env.DB, c.req.param("id"), userId);
	if (plan.status !== "done")
		throw new HttpError(409, "not_ready", "Wait for the plan to finish first.");
	const existing = await c.env.DB.prepare(
		"SELECT token FROM share_links WHERE plan_id = ? AND user_id = ? AND revoked_at IS NULL LIMIT 1",
	)
		.bind(plan.id, userId)
		.first<{ token: string }>();
	if (existing) return c.json({ share_url: shareUrl(existing.token) });
	await rateLimit(c.env.DB, `share:${userId}`, 30, 3600);
	const token = newShareToken();
	await c.env.DB.prepare("INSERT INTO share_links (token, plan_id, user_id) VALUES (?, ?, ?)")
		.bind(token, plan.id, userId)
		.run();
	return c.json({ share_url: shareUrl(token) }, 201);
});

trips.post("/plans/:id/share/revoke", ...signedIn, async (c) => {
	const userId = c.get("userId");
	const plan = await ownedPlan(c.env.DB, c.req.param("id"), userId);
	await c.env.DB.prepare(
		"UPDATE share_links SET revoked_at = ? WHERE plan_id = ? AND user_id = ? AND revoked_at IS NULL",
	)
		.bind(nowIso(), plan.id, userId)
		.run();
	return c.json({ share_url: null });
});

/**
 * Public, read-only. Shows the plan the link was made for and nothing else:
 * no account details, no free-text request, no coordinates, no accessibility
 * notes. A revoked or unknown token is a plain 404.
 */
trips.get("/shared/:token", async (c) => {
	const token = c.req.param("token");
	const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
	await rateLimit(c.env.DB, `shared:${ip}`, 120, 60);
	c.header("Cache-Control", "no-store");
	c.header("X-Robots-Tag", "noindex");
	if (!SHARE_TOKEN_RE.test(token))
		throw new HttpError(404, "not_found", "This link doesn't work any more.");
	const link = await c.env.DB.prepare(
		"SELECT plan_id, user_id FROM share_links WHERE token = ? AND revoked_at IS NULL",
	)
		.bind(token)
		.first<{ plan_id: string; user_id: string }>();
	if (!link) throw new HttpError(404, "not_found", "This link doesn't work any more.");
	const plan = await loadPlan(c.env.DB, link.plan_id, link.user_id);
	if (!plan) throw new HttpError(404, "not_found", "This link doesn't work any more.");

	const { origin_lat: _lat, origin_lng: _lng, rechecked_from: _r, previous: _p, ...rest } = plan;
	const { accessibility: _a, ...prefs } = plan.prefs;
	return c.json({ ...rest, prefs, previous: null, shared: true });
});
