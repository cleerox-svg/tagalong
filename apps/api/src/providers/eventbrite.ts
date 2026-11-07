/**
 * Eventbrite API v3 → our EventInfo (spec §7: community and niche events).
 *
 * Eventbrite retired public event search in 2020, so Eventbrite events come
 * in by link: a pasted eventbrite.* URL carries the event id, and
 * GET /v3/events/:id returns the event with its ticket price range. Without
 * EVENTBRITE_TOKEN the same link is read as an ordinary event page instead.
 */
import { type EventInfo, normaliseCategory, parseMajor, isCurrencyCode } from "@tagalong/shared";
import { cachedJson, ProviderError } from "../lib/cache.js";
import type { EventRead } from "./event-page.js";

const BASE = "https://www.eventbriteapi.com/v3";

/** The numeric event id at the end of an Eventbrite event link, if it is one. */
export function eventbriteIdFromUrl(url: URL): string | null {
	if (!/(^|\.)eventbrite\.[a-z.]{2,10}$/i.test(url.hostname)) return null;
	const m = /\/e\/(?:[^/?#]*-)?(\d{6,20})\/?$/.exec(url.pathname);
	return m?.[1] ?? null;
}

interface EbPrice {
	currency?: string;
	major_value?: string;
}

interface EbEvent {
	id?: string;
	name?: { text?: string };
	url?: string;
	currency?: string;
	status?: string;
	online_event?: boolean;
	is_free?: boolean;
	start?: { local?: string; utc?: string };
	category?: { name?: string; short_name?: string } | null;
	venue?: {
		name?: string;
		latitude?: string;
		longitude?: string;
		address?: {
			city?: string;
			country?: string;
			latitude?: string;
			longitude?: string;
		};
	} | null;
	ticket_availability?: {
		minimum_ticket_price?: EbPrice | null;
		maximum_ticket_price?: EbPrice | null;
	} | null;
}

function minor(p: EbPrice | null | undefined): { amount: number; currency: string } | null {
	const currency = p?.currency?.toUpperCase();
	if (!currency || !isCurrencyCode(currency) || typeof p?.major_value !== "string") return null;
	try {
		return { amount: parseMajor(p.major_value, currency), currency };
	} catch {
		return null;
	}
}

const coord = (v: string | undefined, limit: number): number | null => {
	if (!v) return null;
	const n = Number(v);
	return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

export function mapEventbrite(e: EbEvent): EventRead {
	const name = e.name?.text?.trim().slice(0, 200);
	const localDate = /^(\d{4}-\d{2}-\d{2})/.exec(e.start?.local ?? "")?.[1];
	const online = e.online_event === true;
	const cancelled = e.status === "canceled";
	if (!e.id || !name || !localDate) return { event: null, online, cancelled, title: name ?? null };

	const lo = minor(e.ticket_availability?.minimum_ticket_price);
	const hi = minor(e.ticket_availability?.maximum_ticket_price);
	let price_range: EventInfo["price_range"] = null;
	if (lo && hi && lo.currency === hi.currency && hi.amount >= lo.amount) {
		price_range = { min_minor: lo.amount, max_minor: hi.amount, currency: lo.currency };
	} else if (lo) {
		price_range = { min_minor: lo.amount, max_minor: lo.amount, currency: lo.currency };
	} else if (e.is_free) {
		const cur = e.currency?.toUpperCase();
		price_range = {
			min_minor: 0,
			max_minor: 0,
			currency: cur && isCurrencyCode(cur) ? cur : "USD",
		};
	}

	const v = e.venue;
	const country = v?.address?.country?.toUpperCase();
	const lat = coord(v?.address?.latitude ?? v?.latitude, 90);
	const lng = coord(v?.address?.longitude ?? v?.longitude, 180);
	return {
		event: {
			provider: "eventbrite",
			provider_event_id: e.id,
			name,
			category: normaliseCategory(e.category?.name ?? e.category?.short_name),
			venue_name: v?.name?.trim() || null,
			city: v?.address?.city?.trim() || null,
			country_code: country && /^[A-Z]{2}$/.test(country) ? country : null,
			lat: lat !== null && lng !== null ? lat : null,
			lng: lat !== null && lng !== null ? lng : null,
			local_date: localDate,
			starts_at: e.start?.utc && !Number.isNaN(Date.parse(e.start.utc)) ? e.start.utc : null,
			url: e.url ?? `https://www.eventbrite.com/e/${e.id}`,
			price_range,
		},
		online,
		cancelled,
		title: name,
	};
}

/** Ticket ranges change as tiers sell out: a short TTL. */
const TTL = 15 * 60;

/** null when Eventbrite has no such event. */
export async function getEventbriteEvent(
	token: string,
	id: string,
	opts: { fresh?: boolean } = {},
): Promise<EventRead | null> {
	return cachedJson(
		`eventbrite/event/${encodeURIComponent(id)}`,
		TTL,
		async () => {
			const q = new URLSearchParams({ expand: "venue,ticket_availability,category" });
			let res: Response;
			try {
				res = await fetch(`${BASE}/events/${encodeURIComponent(id)}/?${q}`, {
					headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
					signal: AbortSignal.timeout(8000),
				});
			} catch {
				throw new ProviderError("eventbrite", "fetch failed");
			}
			if (res.status === 404) return null;
			if (!res.ok) throw new ProviderError("eventbrite", `HTTP ${res.status}`);
			return mapEventbrite((await res.json()) as EbEvent);
		},
		opts,
	);
}
