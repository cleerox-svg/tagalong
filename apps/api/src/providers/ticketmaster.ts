/**
 * Ticketmaster Discovery API v2 → our EventInfo. Price ranges, when listed,
 * are face value; fees are added separately as an estimate.
 */
import { currencyExponent, type EventInfo, isCurrencyCode } from "@tagalong/shared";
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

export async function searchEvents(apiKey: string, s: EventSearch): Promise<EventInfo[]> {
	const params = new URLSearchParams({
		keyword: s.keyword,
		startDateTime: `${s.date_from}T00:00:00Z`,
		endDateTime: `${s.date_to}T23:59:59Z`,
		size: "10",
		sort: "relevance,desc",
		locale: "*",
	});
	if (s.city) params.set("city", s.city);
	return cachedJson(`tm/search?${params}`, SEARCH_TTL, async () => {
		const body = (await tmGet(apiKey, "/events.json", params)) as {
			_embedded?: { events?: TmEvent[] };
		} | null;
		return (body?._embedded?.events ?? []).map(mapEvent).filter((e): e is EventInfo => e !== null);
	});
}

export async function getEvent(apiKey: string, id: string): Promise<EventInfo | null> {
	return cachedJson(`tm/event/${encodeURIComponent(id)}`, SEARCH_TTL, async () => {
		const body = (await tmGet(
			apiKey,
			`/events/${encodeURIComponent(id)}.json`,
			new URLSearchParams({ locale: "*" }),
		)) as TmEvent | null;
		return body ? mapEvent(body) : null;
	});
}
