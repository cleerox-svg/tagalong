/**
 * Booking.com Demand API 3.1 (spec §7): the cheapest available stay near the
 * venue, all charges included, with Booking.com's own property link.
 *
 * Docs: https://developers.booking.com/demand/docs/open-api/demand-api/accommodations
 */
import { type CandidateItem, currencyExponent, isCurrencyCode } from "@tagalong/shared";
import { cachedJson, ProviderError } from "../lib/cache.js";

export const STAY_TTL = 15 * 60;
/** Search radius around the venue, km. */
export const STAY_RADIUS_KM = 5;

export interface StaySearch {
	lat: number;
	lng: number;
	check_in: string;
	check_out: string;
	adults: number;
	rooms: number;
	currency: string;
	/** Booker's country (ISO 3166-1 alpha-2): affects prices and tax display. */
	booker_country: string;
}

export interface StayOffer {
	id: number;
	name: string | null;
	amount_minor: number;
	currency: string;
	url: string | null;
	all_charges_included: boolean;
}

interface Creds {
	base: string;
	token: string;
	affiliateId: string;
}

async function post(c: Creds, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
	const res = await fetch(`${c.base}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${c.token}`,
			"X-Affiliate-Id": c.affiliateId,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		...(signal ? { signal } : {}),
	});
	if (!res.ok) throw new ProviderError("booking.com", `${path} HTTP ${res.status}`);
	return res.json();
}

interface SearchItem {
	id?: number;
	currency?: string;
	price?: { book?: number; total?: number };
	url?: string;
}

function pickName(name: unknown): string | null {
	if (typeof name === "string") return name;
	if (name && typeof name === "object") {
		const byLang = name as Record<string, unknown>;
		const v = byLang["en-gb"] ?? byLang["en-us"] ?? Object.values(byLang)[0];
		return typeof v === "string" ? v : null;
	}
	return null;
}

export async function cheapestStay(
	c: Creds,
	s: StaySearch,
	opts: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<StayOffer | null> {
	const key = `booking/search?${new URLSearchParams({
		lat: s.lat.toFixed(4),
		lng: s.lng.toFixed(4),
		in: s.check_in,
		out: s.check_out,
		a: String(s.adults),
		r: String(s.rooms),
		cur: s.currency,
		bc: s.booker_country,
	})}`;
	return cachedJson(
		key,
		STAY_TTL,
		async () => {
			const body = (await post(
				c,
				"/accommodations/search",
				{
					booker: { country: s.booker_country.toLowerCase(), platform: "desktop" },
					checkin: s.check_in,
					checkout: s.check_out,
					coordinates: { latitude: s.lat, longitude: s.lng, radius: STAY_RADIUS_KM },
					guests: { number_of_adults: s.adults, number_of_rooms: s.rooms },
					currency: s.currency,
					extras: ["extra_charges"],
					sort: { by: "price", direction: "ascending" },
					rows: 10,
				},
				opts.signal,
			)) as { data?: SearchItem[] };

			let best: (StayOffer & { major: number }) | null = null;
			for (const d of body.data ?? []) {
				const currency = d.currency ?? s.currency;
				const total = d.price?.total ?? d.price?.book;
				if (
					typeof d.id !== "number" ||
					typeof total !== "number" ||
					total <= 0 ||
					!isCurrencyCode(currency)
				)
					continue;
				if (currency !== s.currency) continue;
				if (!best || total < best.major) {
					best = {
						id: d.id,
						name: null,
						major: total,
						amount_minor: Math.round(total * 10 ** currencyExponent(currency)),
						currency,
						url: d.url ?? null,
						all_charges_included: typeof d.price?.total === "number",
					};
				}
			}
			if (!best) return null;

			// The name is a nicety: a failure here must not lose the price.
			try {
				const details = (await post(
					c,
					"/accommodations/details",
					{ accommodations: [best.id], languages: ["en-gb"] },
					opts.signal,
				)) as { data?: Array<{ id?: number; name?: unknown }> };
				best.name = pickName(details.data?.find((x) => x.id === best?.id)?.name);
			} catch {
				best.name = null;
			}
			const { major: _major, ...offer } = best;
			return offer;
		},
		opts,
	);
}

export function stayItem(
	offer: StayOffer,
	s: StaySearch,
	nights: number,
	fetchedAt: string,
): CandidateItem {
	const fallbackUrl = `https://www.booking.com/searchresults.html?latitude=${s.lat}&longitude=${s.lng}&checkin=${s.check_in}&checkout=${s.check_out}&group_adults=${s.adults}&no_rooms=${s.rooms}`;
	return {
		kind: "lodging",
		title: `${offer.name ?? "Hotel"} — ${nights} night${nights > 1 ? "s" : ""}, ${s.rooms} room${s.rooms > 1 ? "s" : ""}`,
		provider: "booking.com",
		provider_ref: String(offer.id),
		amount_minor: offer.amount_minor,
		currency: offer.currency,
		is_estimate: false,
		booking_url: offer.url ?? fallbackUrl,
		fetched_at: fetchedAt,
		method: `Cheapest available stay Booking.com listed within ${STAY_RADIUS_KM} km of the venue for ${s.adults} adult${s.adults > 1 ? "s" : ""} in ${s.rooms} room${s.rooms > 1 ? "s" : ""}, ${s.check_in} to ${s.check_out}, ${
			offer.all_charges_included
				? "including taxes and charges"
				: "display price; some charges may be added at booking"
		}. Search prices can change; Booking.com confirms the price when you book.`,
	};
}
