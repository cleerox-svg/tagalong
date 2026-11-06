/**
 * Duffel flight offers (spec §7). Prices are real airline offers for the
 * whole party; we show the cheapest and link out to search for it — Budgetrip
 * does not book through Duffel (spec §2.2).
 *
 * Docs: https://duffel.com/docs/api/v2/offer-requests/create-offer-request
 */
import { type CandidateItem, currencyExponent, isCurrencyCode, type Place } from "@tagalong/shared";
import { cachedJson, ProviderError } from "../lib/cache.js";

const BASE = "https://api.duffel.com";
export const FLIGHT_TTL = 10 * 60;

function headers(token: string): HeadersInit {
	return {
		Authorization: `Bearer ${token}`,
		"Duffel-Version": "v2",
		Accept: "application/json",
		"Content-Type": "application/json",
	};
}

interface Suggestion {
	type?: string;
	iata_code?: string;
	iata_city_code?: string | null;
	name?: string;
}

/**
 * The IATA code to fly from/to for a city: its metropolitan city code when it
 * has one (YTO, NYC — all its airports), else the nearest airport.
 */
export async function airportCodeNear(
	token: string,
	place: { lat: number; lng: number },
	signal?: AbortSignal,
): Promise<string | null> {
	const lat = place.lat.toFixed(2);
	const lng = place.lng.toFixed(2);
	return cachedJson(`duffel/near?lat=${lat}&lng=${lng}`, 30 * 86400, async () => {
		const q = new URLSearchParams({ lat, lng, rad: "100000" });
		const res = await fetch(`${BASE}/places/suggestions?${q}`, {
			headers: headers(token),
			...(signal ? { signal } : {}),
		});
		if (!res.ok) throw new ProviderError("duffel", `places HTTP ${res.status}`);
		const body = (await res.json()) as { data?: Suggestion[] };
		for (const s of body.data ?? []) {
			const code = s.iata_city_code || s.iata_code;
			if (code && /^[A-Z]{3}$/.test(code)) return code;
		}
		return null;
	});
}

interface DuffelOffer {
	id: string;
	total_amount: string;
	total_currency: string;
	expires_at?: string;
	owner?: { name?: string };
	slices?: Array<{ duration?: string; segments?: unknown[] }>;
}

export interface FlightOffer {
	id: string;
	amount_minor: number;
	currency: string;
	airline: string;
	expires_at: string | null;
	stops_out: number;
	stops_back: number;
}

function toMinor(amount: string, currency: string): number | null {
	const n = Number(amount);
	if (!Number.isFinite(n) || n <= 0 || !isCurrencyCode(currency)) return null;
	return Math.round(n * 10 ** currencyExponent(currency));
}

export interface FlightSearch {
	from: string;
	to: string;
	out: string;
	back: string;
	adults: number;
}

/** Cheapest round-trip economy offer, max one stop each way, or null if none. */
export async function cheapestRoundTrip(
	token: string,
	s: FlightSearch,
	opts: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<FlightOffer | null> {
	const key = `duffel/offers?${new URLSearchParams({ ...s, adults: String(s.adults) })}`;
	return cachedJson(
		key,
		FLIGHT_TTL,
		async () => {
			const res = await fetch(
				`${BASE}/air/offer_requests?return_offers=true&supplier_timeout=10000`,
				{
					method: "POST",
					headers: headers(token),
					body: JSON.stringify({
						data: {
							slices: [
								{ origin: s.from, destination: s.to, departure_date: s.out },
								{ origin: s.to, destination: s.from, departure_date: s.back },
							],
							passengers: Array.from({ length: s.adults }, () => ({ type: "adult" })),
							cabin_class: "economy",
							max_connections: 1,
						},
					}),
					...(opts.signal ? { signal: opts.signal } : {}),
				},
			);
			if (!res.ok) throw new ProviderError("duffel", `offer request HTTP ${res.status}`);
			const body = (await res.json()) as { data?: { offers?: DuffelOffer[] } };
			let best: FlightOffer | null = null;
			for (const o of body.data?.offers ?? []) {
				const amount = toMinor(o.total_amount, o.total_currency);
				if (amount === null) continue;
				// Offers can come in more than one currency; compare like with like only.
				if (best && o.total_currency !== best.currency) continue;
				if (!best || amount < best.amount_minor) {
					best = {
						id: o.id,
						amount_minor: amount,
						currency: o.total_currency,
						airline: o.owner?.name ?? "Airline",
						expires_at: o.expires_at ?? null,
						stops_out: Math.max(0, (o.slices?.[0]?.segments?.length ?? 1) - 1),
						stops_back: Math.max(0, (o.slices?.[1]?.segments?.length ?? 1) - 1),
					};
				}
			}
			return best;
		},
		opts,
	);
}

const stops = (n: number) => (n === 0 ? "direct" : `${n} stop${n > 1 ? "s" : ""}`);

export function flightItem(
	offer: FlightOffer,
	s: FlightSearch,
	origin: Place,
	venueCity: string,
	fetchedAt: string,
): CandidateItem {
	return {
		kind: "transport",
		title: `Round-trip flights × ${s.adults} — ${offer.airline}, ${s.from}→${s.to} (${stops(offer.stops_out)} out, ${stops(offer.stops_back)} back)`,
		provider: "duffel",
		provider_ref: offer.id,
		amount_minor: offer.amount_minor,
		currency: offer.currency,
		is_estimate: false,
		booking_url: `https://www.google.com/travel/flights?q=${encodeURIComponent(
			`Flights from ${s.from} to ${s.to} on ${s.out} through ${s.back}`,
		)}`,
		fetched_at: fetchedAt,
		method: `Cheapest economy offer Duffel returned for ${s.adults} adult${s.adults > 1 ? "s" : ""}, ${s.from} (${origin.label}) → ${s.to} (${venueCity}), out ${s.out}, back ${s.back}, at most 1 stop each way.${
			offer.expires_at
				? ` Fares change; this one was held until ${offer.expires_at}.`
				: " Fares change."
		}`,
	};
}
