/**
 * Phase 4 (spec §9 "Any event"): read a pasted event link, and browse events
 * by category near a city. Nothing here plans or stores a trip; the app pins
 * the chosen event into the confirm form and POST /plans does the rest.
 */
import {
	addDays,
	BROWSE_MAX_DAYS,
	BROWSE_RADIUS_KM,
	EVENT_CATEGORY_IDS,
	type EventInfo,
	eventCategory,
	type PinnedEvent,
} from "@tagalong/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAdult, requireUser } from "../auth/session.js";
import { ProviderError } from "../lib/cache.js";
import { HttpError, newId, nowIso, readJson, type AppEnv } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { requireTrustedWrite } from "../lib/security.js";
import { lookupEventUrl } from "../planning/events.js";
import { browseEvents } from "../providers/ticketmaster.js";

export const events = new Hono<AppEnv>();

const signedIn = [requireTrustedWrite, requireUser] as const;

/** What the app shows for an event and pins into the confirm form. */
function summary(e: EventInfo, pinned: PinnedEvent) {
	return {
		pinned,
		provider: e.provider,
		name: e.name,
		category: e.category,
		venue_name: e.venue_name,
		city: e.city,
		country_code: e.country_code,
		local_date: e.local_date,
		starts_at: e.starts_at,
		url: e.url,
		price_range: e.price_range,
	};
}

/** Keeps what a link said, so a later run can still plan if the page goes down. */
async function remember(db: D1Database, e: EventInfo, fetchedAt: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO events (id, provider, provider_event_id, name, category, venue_name, city, country, lat, lng,
			   local_date, starts_at, url, price_min_minor, price_max_minor, price_currency, fetched_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (provider, provider_event_id) DO UPDATE SET
			   name = excluded.name, category = excluded.category, venue_name = excluded.venue_name,
			   city = excluded.city, country = excluded.country, lat = excluded.lat, lng = excluded.lng,
			   local_date = excluded.local_date, starts_at = excluded.starts_at, url = excluded.url,
			   price_min_minor = excluded.price_min_minor, price_max_minor = excluded.price_max_minor,
			   price_currency = excluded.price_currency, fetched_at = excluded.fetched_at`,
		)
		.bind(
			newId(),
			e.provider,
			e.provider_event_id,
			e.name,
			e.category,
			e.venue_name,
			e.city,
			e.country_code,
			e.lat,
			e.lng,
			e.local_date,
			e.starts_at,
			e.url,
			e.price_range?.min_minor ?? null,
			e.price_range?.max_minor ?? null,
			e.price_range?.currency ?? null,
			fetchedAt,
		)
		.run();
}

const LookupBody = z.object({ url: z.string().trim().min(8).max(2000) });

/** A pasted link → the event it describes, or why it can't be planned. */
events.post("/events/lookup", ...signedIn, requireAdult, async (c) => {
	const body = LookupBody.safeParse(await readJson(c));
	if (!body.success) throw new HttpError(400, "invalid", "Paste the event's full link.");
	await rateLimit(c.env.DB, `lookup:${c.get("userId")}`, 30, 3600);
	const now = nowIso();
	// A day of slack: an event tonight in Los Angeles is already "tomorrow" in UTC.
	const out = await lookupEventUrl(c.env, body.data.url, addDays(now.slice(0, 10), -1));
	if (!out.ok) {
		throw new HttpError(422, out.reason, out.message, { title: out.title });
	}
	await remember(c.env.DB, out.event, now);
	return c.json({ event: summary(out.event, out.pinned) });
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const BrowseQuery = z
	.object({
		category: z.enum(EVENT_CATEGORY_IDS),
		lat: z.coerce.number().min(-90).max(90),
		lng: z.coerce.number().min(-180).max(180),
		radius_km: z.coerce
			.number()
			.int()
			.refine((n) => (BROWSE_RADIUS_KM as readonly number[]).includes(n)),
		date_from: isoDate,
		date_to: isoDate,
	})
	.refine((q) => q.date_from <= q.date_to && q.date_to <= addDays(q.date_from, BROWSE_MAX_DAYS));

/** "Gaming events near Toronto in May": Ticketmaster, by category, radius and dates. */
events.get("/events/browse", ...signedIn, async (c) => {
	const q = BrowseQuery.safeParse(c.req.query());
	if (!q.success)
		throw new HttpError(
			400,
			"invalid",
			"Pick a category, a city and dates (up to a year apart).",
			q.error.issues,
		);
	await rateLimit(c.env.DB, `browse:${c.get("userId")}`, 60, 3600);
	const category = eventCategory(q.data.category);
	if (!category) throw new HttpError(400, "invalid", "No such category.");
	try {
		const found = await browseEvents(c.env.TICKETMASTER_API_KEY, { ...q.data, category });
		return c.json({
			events: found.map((e) => summary(e, { provider: "ticketmaster", id: e.provider_event_id })),
		});
	} catch (err) {
		if (err instanceof ProviderError)
			throw new HttpError(502, "provider", "Event search isn't answering right now.");
		throw err;
	}
});
