import { Hono } from "hono";
import { TripRequestSchema } from "@tagalong/shared";
import { z } from "zod";
import { requireAdult, requireUser } from "../auth/session.js";
import { ProviderError } from "../lib/cache.js";
import { HttpError, newId, readJson, type AppEnv } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { requireTrustedWrite } from "../lib/security.js";
import { parseTripText } from "../providers/anthropic.js";
import { searchCities } from "../providers/google-places.js";
import { runPlan } from "../planning/run.js";
import { loadPlan } from "../planning/view.js";

export const plans = new Hono<AppEnv>();

// Per route rather than plans.use("*"): mounted at "/", a wildcard here would
// also guard /health and turn unknown paths into 401s.
const signedIn = [requireTrustedWrite, requireUser] as const;

/** Origin lookup. More than one result means "ask which one" (spec §5). */
plans.get("/places", ...signedIn, async (c) => {
	const q = z.string().trim().min(2).max(120).safeParse(c.req.query("q"));
	if (!q.success) throw new HttpError(400, "invalid", "Type at least two letters of a city.");
	await rateLimit(c.env.DB, `places:${c.get("userId")}`, 60, 60);
	try {
		return c.json({ places: await searchCities(c.env.GOOGLE_MAPS_API_KEY, q.data) });
	} catch (err) {
		if (err instanceof ProviderError)
			throw new HttpError(502, "provider", "City search isn't answering right now.");
		throw err;
	}
});

const ParseBody = z.object({ text: z.string().trim().min(3).max(2000) });

/** Free text → fields for the confirm form. Nothing is planned or stored. */
plans.post("/trip-requests/parse", ...signedIn, requireAdult, async (c) => {
	const body = ParseBody.safeParse(await readJson(c));
	if (!body.success)
		throw new HttpError(
			400,
			"invalid",
			"Describe your trip in a few words (up to 2,000 characters).",
		);
	await rateLimit(c.env.DB, `parse:${c.get("userId")}`, 20, 3600);
	const today = new Date().toISOString().slice(0, 10);
	const out = await parseTripText(c.env.ANTHROPIC_API_KEY, body.data.text, today);
	if (!out.ok) {
		throw new HttpError(422, "unparsed", "We couldn't read that. Fill in the form below instead.", {
			reason: out.reason,
		});
	}
	return c.json({ parsed: out.parsed });
});

/** Start a planning run from a confirmed request. */
plans.post("/plans", ...signedIn, requireAdult, async (c) => {
	const body = TripRequestSchema.safeParse(await readJson(c));
	if (!body.success)
		throw new HttpError(
			400,
			"invalid",
			"Some trip details are missing or invalid.",
			body.error.issues,
		);
	const r = body.data;
	await rateLimit(c.env.DB, `plan:${c.get("userId")}`, 20, 3600);

	const tripId = newId();
	const planId = newId();
	await c.env.DB.batch([
		c.env.DB.prepare(
			`INSERT INTO trip_requests (id, user_id, raw_text, origin_city, origin_lat, origin_lng, origin_country,
			   event_query, event_city, event_pinned_id, date_from, date_to, party_size, budget_minor, budget_currency,
			   budget_scope, prefs_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			tripId,
			c.get("userId"),
			r.raw_text ?? null,
			r.origin.label,
			r.origin.lat,
			r.origin.lng,
			r.origin.country_code,
			r.event.query,
			r.event.city ?? null,
			r.event.ticketmaster_event_id ?? null,
			r.date_from,
			r.date_to,
			r.party_size,
			r.budget.amount_minor,
			r.budget.currency,
			r.budget.scope,
			JSON.stringify(r.prefs),
		),
		c.env.DB.prepare(
			"INSERT INTO plans (id, user_id, trip_request_id, status, progress) VALUES (?, ?, ?, 'queued', 'Starting…')",
		).bind(planId, c.get("userId"), tripId),
	]);

	c.executionCtx.waitUntil(runPlan(c.env, planId));
	return c.json({ id: planId, status: "queued" }, 202);
});

/**
 * Re-check prices: a new run of the same trip request that skips cached
 * provider responses. The new plan links back so the app can show the change.
 */
plans.post("/plans/:id/recheck", ...signedIn, requireAdult, async (c) => {
	const prev = await c.env.DB.prepare(
		"SELECT id, trip_request_id, status FROM plans WHERE id = ? AND user_id = ?",
	)
		.bind(c.req.param("id"), c.get("userId"))
		.first<{ id: string; trip_request_id: string; status: string }>();
	if (!prev) throw new HttpError(404, "not_found", "No such plan.");
	if (prev.status === "queued" || prev.status === "running") {
		throw new HttpError(409, "busy", "This plan is still running.");
	}
	await rateLimit(c.env.DB, `plan:${c.get("userId")}`, 20, 3600);

	const planId = newId();
	await c.env.DB.prepare(
		`INSERT INTO plans (id, user_id, trip_request_id, status, progress, rechecked_from)
		 VALUES (?, ?, ?, 'queued', 'Re-checking prices…', ?)`,
	)
		.bind(planId, c.get("userId"), prev.trip_request_id, prev.id)
		.run();
	c.executionCtx.waitUntil(runPlan(c.env, planId, { fresh: true }));
	return c.json({ id: planId, status: "queued" }, 202);
});

plans.get("/plans", ...signedIn, async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT p.id, p.status, p.created_at, t.event_query, t.origin_city, e.name AS event_name, e.local_date
		 FROM plans p JOIN trip_requests t ON t.id = p.trip_request_id LEFT JOIN events e ON e.id = p.event_id
		 WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 20`,
	)
		.bind(c.get("userId"))
		.all();
	return c.json({ plans: results });
});

plans.get("/plans/:id", ...signedIn, async (c) => {
	const plan = await loadPlan(c.env.DB, c.req.param("id"), c.get("userId"));
	if (!plan) throw new HttpError(404, "not_found", "No such plan.");
	return c.json(plan);
});
