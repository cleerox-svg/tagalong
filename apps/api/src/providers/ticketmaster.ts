/**
 * Ticketmaster Discovery API v2 → our EventInfo. Price ranges, when listed,
 * are face value; fees are added separately as an estimate.
 */
import {
	BROWSE_PAGE_SIZE,
	currencyExponent,
	type EventCategory,
	type EventInfo,
	geohash,
	isCurrencyCode,
} from "@tagalong/shared";
import { cachedJson, ProviderError } from "../lib/cache.js";

const BASE = "https://app.ticketmaster.com/discovery/v2";

interface TmEvent {
	id: string;
	name: string;
	url?: string;
	dates?: { start?: { localDate?: string; dateTime?: string } };
	classifications?: Array<{ segment?: { name?: string } }>;
	priceRanges?: Array<{ type?: string; currency?: string; min?: number; max?: number }>;
	_embedded?: {
		venues?: Array<{
			name?: string;
			city?: { name?: string };
			country?: { countryCode?: string };
			location?: { latitude?: string; longitude?: string };
		}>;
	};
}

function toMinor(major: number, currency: string): number {
	return Math.round(major * 10 ** currencyExponent(currency));
}

export function mapEvent(e: TmEvent): EventInfo | null {
	const localDate = e.dates?.start?.localDate;
	if (!e.id || !e.name || !localDate || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null;
	const venue = e._embedded?.venues?.[0];
	const lat = Number(venue?.location?.latitude);
	const lng = Number(venue?.location?.longitude);
	const range =
		e.priceRanges?.find((p) => p.type === "standard" && p.currency && isCurrencyCode(p.currency)) ??
		e.priceRanges?.find((p) => p.currency && isCurrencyCode(p.currency));
	const segment = e.classifications?.[0]?.segment?.name;
	const country = venue?.country?.countryCode;
	return {
		provider: "ticketmaster",
		provider_event_id: e.id,
		name: e.name,
		category: segment && segment !== "Undefined" ? segment : null,
		venue_name: venue?.name ?? null,
		city: venue?.city?.name ?? null,
		country_code: country && /^[A-Z]{2}$/.test(country) ? country : null,
		lat: Number.isFinite(lat) && venue?.location?.latitude ? lat : null,
		lng: Number.isFinite(lng) && venue?.location?.longitude ? lng : null,
		local_date: localDate,
		starts_at: e.dates?.start?.dateTime ?? null,
		url: e.url ?? null,
		price_range:
			range?.currency &&
			typeof range.min === "number" &&
			typeof range.max === "number" &&
			range.min > 0
				? {
						min_minor: toMinor(range.min, range.currency),
						max_minor: toMinor(Math.max(range.max, range.min), range.currency),
						currency: range.currency,
					}
				: null,
	};
}

async function tmGet(apiKey: string, path: string, params: URLSearchParams): Promise<unknown> {
	const q = new URLSearchParams(params);
	q.set("apikey", apiKey);
	const res = await fetch(`${BASE}${path}?${q}`, { headers: { Accept: "application/json" } });
	if (res.status === 404) return null;
	if (!res.ok) throw new ProviderError("ticketmaster", `HTTP ${res.status}`);
	return res.json();
}

export interface EventSearch {
	keyword: string;
	city?: string | undefined;
	date_from: string;
	date_to: string;
}

/** Prices change: a short TTL. */
const SEARCH_TTL = 15 * 60;

export async function searchEvents(
	apiKey: string,
	s: EventSearch,
	opts: { fresh?: boolean } = {},
): Promise<EventInfo[]> {
	const params = new URLSearchParams({
		keyword: s.keyword,
		startDateTime: `${s.date_from}T00:00:00Z`,
		endDateTime: `${s.date_to}T23:59:59Z`,
		size: "10",
		sort: "relevance,desc",
		locale: "*",
	});
	if (s.city) params.set("city", s.city);
	return cachedJson(
		`tm/search?${params}`,
		SEARCH_TTL,
		async () => {
			const body = (await tmGet(apiKey, "/events.json", params)) as {
				_embedded?: { events?: TmEvent[] };
			} | null;
			return (body?._embedded?.events ?? [])
				.map(mapEvent)
				.filter((e): e is EventInfo => e !== null);
		},
		opts,
	);
}

export async function getEvent(
	apiKey: string,
	id: string,
	opts: { fresh?: boolean } = {},
): Promise<EventInfo | null> {
	return cachedJson(
		`tm/event/${encodeURIComponent(id)}`,
		SEARCH_TTL,
		async () => {
			const body = (await tmGet(
				apiKey,
				`/events/${encodeURIComponent(id)}.json`,
				new URLSearchParams({ locale: "*" }),
			)) as TmEvent | null;
			return body ? mapEvent(body) : null;
		},
		opts,
	);
}

/** The Discovery event id in a ticketmaster.* event link, if it has one. */
export function ticketmasterIdFromUrl(url: URL): string | null {
	if (!/(^|\.)ticketmaster\.[a-z.]{2,10}$/i.test(url.hostname)) return null;
	return /\/event\/([A-Za-z0-9]{6,64})\/?$/.exec(url.pathname)?.[1] ?? null;
}

export interface EventBrowse {
	category: EventCategory;
	lat: number;
	lng: number;
	radius_km: number;
	date_from: string;
	date_to: string;
}

/** Category browse: events of one kind within a radius of a city, soonest first. */
export async function browseEvents(apiKey: string, b: EventBrowse): Promise<EventInfo[]> {
	const params = new URLSearchParams({
		geoPoint: geohash(b.lat, b.lng),
		radius: String(b.radius_km),
		unit: "km",
		startDateTime: `${b.date_from}T00:00:00Z`,
		endDateTime: `${b.date_to}T23:59:59Z`,
		size: String(BROWSE_PAGE_SIZE),
		sort: "date,asc",
		locale: "*",
	});
	const f = b.category.ticketmaster;
	if ("classificationName" in f) params.set("classificationName", f.classificationName);
	else params.set("keyword", f.keyword);
	return cachedJson(`tm/browse?${params}`, SEARCH_TTL, async () => {
		const body = (await tmGet(apiKey, "/events.json", params)) as {
			_embedded?: { events?: TmEvent[] };
		} | null;
		return (body?._embedded?.events ?? []).map(mapEvent).filter((e): e is EventInfo => e !== null);
	});
}
