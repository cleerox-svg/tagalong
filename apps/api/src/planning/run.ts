/**
 * One planning run (spec §3 pipeline): resolve event → gather prices and
 * estimates → build candidates → budget filter + rank (code) → save.
 *
 * Runs after the POST /plans response via waitUntil and records progress on
 * the plan row, which the client polls. Phase 2 moves the fan-out to Queues
 * once there are several slow live-price providers to call.
 */
import {
	buildCandidates,
	type Candidate,
	type EventInfo,
	type LivePrices,
	ESTIMATES_AS_OF,
	ESTIMATES_CURRENCY,
	ESTIMATES_VERSION,
	formatMoney,
	MissingRateError,
	type RankedPackage,
	rankPackages,
	TripRequestSchema,
	type Venue,
} from "@tagalong/shared";
import { ProviderError } from "../lib/cache.js";
import { newId, nowIso } from "../lib/http.js";
import { searchCities } from "../providers/google-places.js";
import { getEvent, searchEvents } from "../providers/ticketmaster.js";
import { loadFx } from "./fx.js";
import { gatherLive, type LiveResult } from "./live.js";

/** A user-facing failure. Its message is shown as-is. */
class PlanFailure extends Error {}

const MAX_ALTERNATE_EVENTS = 2;

async function setProgress(
	db: D1Database,
	planId: string,
	status: string,
	progress: string | null,
) {
	await db
		.prepare("UPDATE plans SET status = ?, progress = ?, updated_at = ? WHERE id = ?")
		.bind(status, progress, nowIso(), planId)
		.run();
}

async function upsertEvent(db: D1Database, e: EventInfo, fetchedAt: string): Promise<string> {
	const row = await db
		.prepare(
			`INSERT INTO events (id, provider, provider_event_id, name, category, venue_name, city, country, lat, lng,
			   local_date, starts_at, url, price_min_minor, price_max_minor, price_currency, fetched_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (provider, provider_event_id) DO UPDATE SET
			   name = excluded.name, category = excluded.category, venue_name = excluded.venue_name,
			   city = excluded.city, country = excluded.country, lat = excluded.lat, lng = excluded.lng,
			   local_date = excluded.local_date, starts_at = excluded.starts_at, url = excluded.url,
			   price_min_minor = excluded.price_min_minor, price_max_minor = excluded.price_max_minor,
			   price_currency = excluded.price_currency, fetched_at = excluded.fetched_at
			 RETURNING id`,
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
		.first<{ id: string }>();
	if (!row) throw new Error("event upsert returned nothing");
	return row.id;
}

async function resolveVenue(env: Env, e: EventInfo): Promise<Venue | null> {
	if (e.lat !== null && e.lng !== null && e.country_code && e.city) {
		return { lat: e.lat, lng: e.lng, country_code: e.country_code, city: e.city };
	}
	const q = [e.venue_name, e.city].filter(Boolean).join(", ");
	if (!q) return null;
	const [hit] = await searchCities(env.GOOGLE_MAPS_API_KEY, q);
	return hit
		? { lat: hit.lat, lng: hit.lng, country_code: hit.country_code, city: e.city ?? hit.label }
		: null;
}

function summary(p: RankedPackage, e: EventInfo): string {
	const c = p.candidate;
	const stay =
		c.lodging_type === "none"
			? "a day trip"
			: `${c.nights} night${c.nights > 1 ? "s" : ""} in a ${c.lodging_type}`;
	const total = formatMoney({ amount_minor: c.total_minor, currency: c.currency });
	return `${e.name} on ${e.local_date}: ${c.ticket_tier} seats, ${c.transport_mode} (~${c.travel_hours} h each way), ${stay}. About ${total} all in.`;
}

export interface RunOptions {
	/** Re-check: bypass cached provider responses so every price is fetched again. */
	fresh?: boolean;
}

export async function runPlan(env: Env, planId: string, opts: RunOptions = {}): Promise<void> {
	const db = env.DB;
	try {
		const plan = await db
			.prepare(
				`SELECT p.id, t.raw_text, t.origin_city, t.origin_lat, t.origin_lng, t.origin_country, t.event_query,
				   t.event_city, t.event_pinned_id, t.date_from, t.date_to, t.party_size, t.budget_minor, t.budget_currency, t.budget_scope,
				   t.prefs_json
				 FROM plans p JOIN trip_requests t ON t.id = p.trip_request_id WHERE p.id = ?`,
			)
			.bind(planId)
			.first<Record<string, unknown>>();
		if (!plan) return;
		const request = TripRequestSchema.parse({
			origin: {
				label: plan.origin_city,
				lat: plan.origin_lat,
				lng: plan.origin_lng,
				country_code: plan.origin_country,
			},
			event: {
				query: plan.event_query,
				city: plan.event_city ?? undefined,
				ticketmaster_event_id: plan.event_pinned_id ?? undefined,
			},
			date_from: plan.date_from,
			date_to: plan.date_to,
			party_size: plan.party_size,
			budget: {
				amount_minor: plan.budget_minor,
				currency: plan.budget_currency,
				scope: plan.budget_scope,
			},
			prefs: JSON.parse(String(plan.prefs_json)) as unknown,
		});

		await setProgress(db, planId, "running", "Finding your event…");
		const fetchedAt = nowIso();
		const found = await searchEvents(
			env.TICKETMASTER_API_KEY,
			{
				keyword: request.event.query,
				city: request.event.city,
				date_from: request.date_from,
				date_to: request.date_to,
			},
			opts,
		);
		let primary: EventInfo | undefined;
		if (request.event.ticketmaster_event_id) {
			primary =
				found.find((e) => e.provider_event_id === request.event.ticketmaster_event_id) ??
				(await getEvent(env.TICKETMASTER_API_KEY, request.event.ticketmaster_event_id, opts)) ??
				undefined;
		} else {
			primary = found[0];
		}
		if (!primary) {
			throw new PlanFailure(
				`Ticketmaster has no "${request.event.query}" event between ${request.date_from} and ${request.date_to}. Try other keywords or wider dates.`,
			);
		}
		const alternates = found
			.filter((e) => e.provider_event_id !== primary.provider_event_id && e.name === primary.name)
			.slice(0, MAX_ALTERNATE_EVENTS);
		const others = found
			.filter((e) => e.provider_event_id !== primary.provider_event_id)
			.slice(0, 8);

		const events = [primary, ...alternates];
		const ids = new Map<string, string>();
		for (const e of [...events, ...others]) {
			if (!ids.has(e.provider_event_id))
				ids.set(e.provider_event_id, await upsertEvent(db, e, fetchedAt));
		}
		const primaryId = ids.get(primary.provider_event_id) as string;
		await db.prepare("UPDATE plans SET event_id = ? WHERE id = ?").bind(primaryId, planId).run();

		await setProgress(db, planId, "running", "Pricing tickets, travel and places to stay…");
		const currencies = new Set([request.budget.currency, ESTIMATES_CURRENCY]);
		for (const e of events) if (e.price_range) currencies.add(e.price_range.currency);
		const loadRates = async (cur: Set<string>) => {
			try {
				return await loadFx(db, cur);
			} catch (err) {
				if (err instanceof ProviderError) {
					throw new PlanFailure(
						`We could not get exchange rates for ${[...cur].join(", ")} right now. Try again shortly.`,
					);
				}
				throw err;
			}
		};
		let fx = await loadRates(currencies);

		const build = (e: EventInfo, venue: Venue, live?: LivePrices): Candidate[] => {
			try {
				return buildCandidates({
					request,
					event: e,
					event_id: ids.get(e.provider_event_id) as string,
					venue,
					is_alternative_event: e !== primary,
					fx,
					fetched_at: fetchedAt,
					...(live ? { live } : {}),
				});
			} catch (err) {
				if (err instanceof MissingRateError) {
					throw new PlanFailure(
						`We can't convert ${err.from} to ${err.to} yet, so we can't check this against your budget.`,
					);
				}
				throw err;
			}
		};

		const candidates: Candidate[] = [];
		let liveStatus: LiveResult["status"] = { flights: "not_needed", hotels: "not_needed" };
		for (const e of events) {
			const venue = await resolveVenue(env, e);
			if (!venue) continue;
			if (e !== primary) {
				// Alternative dates keep estimates: live lookups are spent on the event asked for.
				candidates.push(...build(e, venue));
				continue;
			}
			const base = build(e, venue);
			await setProgress(db, planId, "running", "Checking live flight and hotel prices…");
			const live = await gatherLive(env, request, venue, base, opts);
			liveStatus = live.status;
			const extra = [...live.currencies].filter((c) => !currencies.has(c));
			if (extra.length > 0) {
				for (const c of extra) currencies.add(c);
				fx = await loadRates(currencies);
			}
			candidates.push(...build(e, venue, live.live));
		}
		if (candidates.length === 0) {
			throw new PlanFailure(
				`We couldn't work out a way to get from ${request.origin.label} to ${primary.name} within ${request.prefs.max_nights} night(s). Try allowing more nights.`,
			);
		}

		await setProgress(db, planId, "running", "Ranking packages against your budget…");
		const ranked = rankPackages(candidates, request);
		const byId = new Map(events.map((e) => [ids.get(e.provider_event_id), e] as const));

		const stmts: D1PreparedStatement[] = [];
		for (const p of ranked.packages) {
			const c = p.candidate;
			const packageId = newId();
			const event = byId.get(c.event_id) ?? primary;
			stmts.push(
				db
					.prepare(
						`INSERT INTO packages (id, plan_id, rank, label, event_id, total_minor, currency, score, summary_text, details_json)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						packageId,
						planId,
						p.rank,
						p.label,
						c.event_id,
						c.total_minor,
						c.currency,
						p.score,
						summary(p, event),
						JSON.stringify({
							ticket_tier: c.ticket_tier,
							transport_mode: c.transport_mode,
							lodging_type: c.lodging_type,
							nights: c.nights,
							travel_hours: c.travel_hours,
							passport_needed: c.international,
							is_alternative_event: c.is_alternative_event,
						}),
					),
			);
			c.items.forEach((it, i) => {
				stmts.push(
					db
						.prepare(
							`INSERT INTO package_items (id, package_id, position, kind, title, provider, provider_ref, amount_minor,
							   currency, is_estimate, booking_url, fetched_at, method)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.bind(
							newId(),
							packageId,
							i,
							it.kind,
							it.title,
							it.provider,
							it.provider_ref,
							it.amount_minor,
							it.currency,
							it.is_estimate ? 1 : 0,
							it.booking_url,
							it.fetched_at,
							it.method,
						),
				);
			});
		}

		const usedRates = [...currencies]
			.filter((cur) => cur !== request.budget.currency)
			.map((cur) => {
				const r = fx.find(cur, request.budget.currency);
				return r ? { from: cur, to: request.budget.currency, rate: r.rate, as_of: r.as_of } : null;
			})
			.filter(Boolean);

		const result = {
			considered: ranked.considered,
			within_budget: ranked.within_budget,
			budget_total_minor: ranked.budget_total_minor,
			currency: request.budget.currency,
			cheapest_over_budget_minor: ranked.cheapest_over_budget_minor,
			fx: usedRates,
			estimates: { version: ESTIMATES_VERSION, as_of: ESTIMATES_AS_OF },
			live: liveStatus,
			prices_checked_at: fetchedAt,
			other_events: others.map((e) => ({
				ticketmaster_event_id: e.provider_event_id,
				name: e.name,
				local_date: e.local_date,
				venue_name: e.venue_name,
				city: e.city,
			})),
		};
		stmts.push(
			db
				.prepare(
					"UPDATE plans SET status = 'done', progress = NULL, result_json = ?, updated_at = ? WHERE id = ?",
				)
				.bind(JSON.stringify(result), nowIso(), planId),
		);
		// One batch: a plan is either fully saved or not saved at all.
		await db.batch(stmts);
	} catch (err) {
		const message =
			err instanceof PlanFailure
				? err.message
				: err instanceof ProviderError
					? "One of our travel data sources isn't answering right now. Try again in a few minutes."
					: "Something went wrong while planning. Try again.";
		if (!(err instanceof PlanFailure)) console.error("plan failed", planId, err);
		await db
			.prepare(
				"UPDATE plans SET status = 'failed', progress = NULL, error = ?, updated_at = ? WHERE id = ?",
			)
			.bind(message, nowIso(), planId)
			.run();
	}
}
