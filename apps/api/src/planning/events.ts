/**
 * Finding the event a trip is for (spec §3 "resolve event", §9 phase 4).
 *
 * Four ways in:
 *   - a search on Ticketmaster (the phase 1 default),
 *   - a pinned event from a pasted link or a category browse: Ticketmaster,
 *     Eventbrite, or any page with schema.org Event data,
 *   - a described event the user gave a name, city and date for, when no
 *     provider or page has it (e.g. a Facebook event).
 */
import { type EventInfo, type PinnedEvent, pinnedEvent, type TripRequest } from "@tagalong/shared";
import { ProviderError } from "../lib/cache.js";
import {
	BlockedUrlError,
	checkPublicUrl,
	type EventRead,
	readEventPage,
	urlId,
} from "../providers/event-page.js";
import { eventbriteIdFromUrl, getEventbriteEvent } from "../providers/eventbrite.js";
import { getEvent, searchEvents, ticketmasterIdFromUrl } from "../providers/ticketmaster.js";

/** A user-facing failure. Its message is shown as-is. */
export class PlanFailure extends Error {}

export type LookupFailure = "blocked" | "unreadable" | "online" | "cancelled" | "past";

export type Lookup =
	| { ok: true; event: EventInfo; pinned: PinnedEvent }
	| { ok: false; reason: LookupFailure; message: string; title: string | null };

const MESSAGES: Record<Exclude<LookupFailure, "blocked">, string> = {
	unreadable:
		"We couldn't read the event details from that page. Tell us the event's date and city instead.",
	online: "That's an online event, so there's no trip to plan.",
	cancelled: "That event has been cancelled.",
	past: "That event has already happened.",
};

const fail = (reason: Exclude<LookupFailure, "blocked">, title: string | null): Lookup => ({
	ok: false,
	reason,
	message: MESSAGES[reason],
	title,
});

function judge(read: EventRead | null, pinned: PinnedEvent, today: string): Lookup {
	if (!read) return fail("unreadable", null);
	if (read.cancelled) return fail("cancelled", read.title);
	if (read.online) return fail("online", read.title);
	if (!read.event) return fail("unreadable", read.title);
	if (read.event.local_date < today) return fail("past", read.event.name);
	return { ok: true, event: read.event, pinned };
}

const ebPage = (id: string) => new URL(`https://www.eventbrite.com/e/${id}`);

async function readEventbrite(env: Env, id: string, fresh: boolean): Promise<EventRead | null> {
	if (env.EVENTBRITE_TOKEN) {
		try {
			const read = await getEventbriteEvent(env.EVENTBRITE_TOKEN, id, { fresh });
			if (read?.event) return read;
		} catch (err) {
			if (!(err instanceof ProviderError)) throw err;
			// Fall through to the public page.
		}
	}
	const page = await readEventPage(ebPage(id), { fresh });
	// The page read is keyed by its URL; keep the Eventbrite identity.
	if (page.event) page.event = { ...page.event, provider: "eventbrite", provider_event_id: id };
	return page;
}

/** A pasted link → one event, or a reason it can't be planned. */
export async function lookupEventUrl(
	env: Env,
	raw: string,
	today: string,
	opts: { fresh?: boolean } = {},
): Promise<Lookup> {
	let url: URL;
	try {
		url = checkPublicUrl(raw);
	} catch (err) {
		if (err instanceof BlockedUrlError)
			return { ok: false, reason: "blocked", message: err.message, title: null };
		throw err;
	}
	const fresh = opts.fresh === true;
	try {
		const ebId = eventbriteIdFromUrl(url);
		if (ebId)
			return judge(
				await readEventbrite(env, ebId, fresh),
				{ provider: "eventbrite", id: ebId },
				today,
			);

		const tmId = ticketmasterIdFromUrl(url);
		if (tmId) {
			const e = await getEvent(env.TICKETMASTER_API_KEY, tmId, opts).catch((err: unknown) => {
				if (err instanceof ProviderError) return null;
				throw err;
			});
			if (e)
				return judge(
					{ event: e, online: false, cancelled: false, title: e.name },
					{ provider: "ticketmaster", id: tmId },
					today,
				);
		}

		return judge(await readEventPage(url, opts), { provider: "url", url: url.href }, today);
	} catch (err) {
		if (err instanceof BlockedUrlError)
			return { ok: false, reason: "blocked", message: err.message, title: null };
		if (err instanceof ProviderError) return fail("unreadable", null);
		throw err;
	}
}

async function storedEvent(
	db: D1Database,
	provider: string,
	providerEventId: string,
): Promise<EventInfo | null> {
	const r = await db
		.prepare(
			`SELECT provider, provider_event_id, name, category, venue_name, city, country, lat, lng, local_date,
			   starts_at, url, price_min_minor, price_max_minor, price_currency
			 FROM events WHERE provider = ? AND provider_event_id = ?`,
		)
		.bind(provider, providerEventId)
		.first<Record<string, unknown>>();
	if (!r || typeof r.local_date !== "string") return null;
	return {
		provider: r.provider as EventInfo["provider"],
		provider_event_id: String(r.provider_event_id),
		name: String(r.name),
		category: (r.category as string | null) ?? null,
		venue_name: (r.venue_name as string | null) ?? null,
		city: (r.city as string | null) ?? null,
		country_code: (r.country as string | null) ?? null,
		lat: (r.lat as number | null) ?? null,
		lng: (r.lng as number | null) ?? null,
		local_date: r.local_date,
		starts_at: (r.starts_at as string | null) ?? null,
		url: (r.url as string | null) ?? null,
		price_range:
			typeof r.price_min_minor === "number" &&
			typeof r.price_max_minor === "number" &&
			typeof r.price_currency === "string"
				? {
						min_minor: r.price_min_minor,
						max_minor: r.price_max_minor,
						currency: r.price_currency,
					}
				: null,
	};
}

/** The event a user described. Keyed by what they typed, so the same description reuses one row. */
async function describedEvent(r: TripRequest): Promise<EventInfo> {
	const key = `${r.event.query.trim().toLowerCase()}|${(r.event.city ?? "").trim().toLowerCase()}|${r.date_from}`;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	const id = [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return {
		provider: "manual",
		provider_event_id: id,
		name: r.event.query.trim(),
		category: null,
		venue_name: null,
		city: r.event.city?.trim() ?? null,
		country_code: null,
		lat: null,
		lng: null,
		local_date: r.date_from,
		starts_at: null,
		url: null,
		price_range: null,
	};
}

export interface ResolvedEvents {
	primary: EventInfo;
	/** The same event on other dates: planned too, labelled "alternative". */
	alternates: EventInfo[];
	/** Other Ticketmaster matches, offered as "not the right event?". */
	others: EventInfo[];
}

const MAX_ALTERNATE_EVENTS = 2;

function pinnedFailure(l: Extract<Lookup, { ok: false }>): PlanFailure {
	return new PlanFailure(
		l.reason === "unreadable"
			? "We couldn't read that event any more. Start a new plan from its link, or tell us its date and city."
			: l.message,
	);
}

export async function resolveEvents(
	env: Env,
	request: TripRequest,
	today: string,
	opts: { fresh?: boolean } = {},
): Promise<ResolvedEvents> {
	if (request.event.manual) {
		return { primary: await describedEvent(request), alternates: [], others: [] };
	}

	const pinned = pinnedEvent(request);
	if (pinned?.provider === "eventbrite") {
		let read: EventRead | null;
		try {
			read = await readEventbrite(env, pinned.id, opts.fresh === true);
		} catch (err) {
			if (!(err instanceof ProviderError)) throw err;
			const stored = await storedEvent(env.DB, "eventbrite", pinned.id);
			read = stored ? { event: stored, online: false, cancelled: false, title: stored.name } : null;
		}
		const l = judge(read, pinned, today);
		if (!l.ok) throw pinnedFailure(l);
		return { primary: l.event, alternates: [], others: [] };
	}
	if (pinned?.provider === "url") {
		const url = checkPublicUrl(pinned.url);
		let read: EventRead | null;
		try {
			read = await readEventPage(url, opts);
		} catch (err) {
			if (!(err instanceof ProviderError)) throw err;
			// The page is down: plan from what we read when the user pasted it.
			const stored = await storedEvent(env.DB, "url", await urlId(url));
			read = stored ? { event: stored, online: false, cancelled: false, title: stored.name } : null;
		}
		const l = judge(read, pinned, today);
		if (!l.ok) throw pinnedFailure(l);
		return { primary: l.event, alternates: [], others: [] };
	}

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
	if (pinned) {
		primary =
			found.find((e) => e.provider_event_id === pinned.id) ??
			(await getEvent(env.TICKETMASTER_API_KEY, pinned.id, opts)) ??
			undefined;
	} else {
		primary = found[0];
	}
	if (!primary) {
		throw new PlanFailure(
			`Ticketmaster has no "${request.event.query}" event between ${request.date_from} and ${request.date_to}. Try other keywords or wider dates, or paste the event's link.`,
		);
	}
	const p = primary;
	return {
		primary: p,
		alternates: found
			.filter((e) => e.provider_event_id !== p.provider_event_id && e.name === p.name)
			.slice(0, MAX_ALTERNATE_EVENTS),
		others: found.filter((e) => e.provider_event_id !== p.provider_event_id).slice(0, 8),
	};
}
