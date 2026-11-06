/**
 * Phase 2 live prices (spec §9): real flight and hotel prices for the primary
 * event's stay windows. Every lookup is bounded by a timeout and isolated:
 * a missing key, a slow provider or no offers leaves that line as its labelled
 * estimate, and the plan records which happened.
 */
import {
	type Candidate,
	type CandidateItem,
	EST,
	formatMoney,
	type LivePrices,
	lodgingUnits,
	type TripRequest,
	type Venue,
	windowKey,
} from "@tagalong/shared";
import { nowIso } from "../lib/http.js";
import { cheapestStay, stayItem } from "../providers/booking.js";
import { airportCodeNear, cheapestRoundTrip, flightItem } from "../providers/duffel.js";

/** Per provider: what the plan used. */
export type LiveStatus =
	"live" | "partial" | "no_offers" | "unavailable" | "not_configured" | "not_needed";

export interface LiveResult {
	live: LivePrices;
	status: { flights: LiveStatus; hotels: LiveStatus };
	/** Currencies the live prices came in, for FX. */
	currencies: Set<string>;
}

export const LIVE_TIMEOUT_MS = 12_000;

interface Window {
	check_in: string;
	check_out: string;
	nights: number;
}

function windows(cands: readonly Candidate[], pick: (c: Candidate) => boolean): Window[] {
	const out = new Map<string, Window>();
	for (const c of cands)
		if (pick(c))
			out.set(windowKey(c), { check_in: c.check_in, check_out: c.check_out, nights: c.nights });
	return [...out.values()];
}

function statusOf(found: number, failed: number, asked: number): LiveStatus {
	if (asked === 0) return "not_needed";
	if (found === asked) return "live";
	if (found > 0) return "partial";
	return failed > 0 ? "unavailable" : "no_offers";
}

export async function gatherLive(
	env: Env,
	request: TripRequest,
	venue: Venue,
	base: readonly Candidate[],
	opts: { fresh?: boolean } = {},
): Promise<LiveResult> {
	const fetchedAt = nowIso();
	const currencies = new Set<string>();
	const flights = new Map<string, CandidateItem>();
	const hotels = new Map<string, CandidateItem[]>();
	const party = request.party_size;

	const flightWindows = windows(base, (c) => c.transport_mode === "fly");
	const hotelWindows = windows(base, (c) => c.lodging_type === "hotel" && c.nights > 0);

	// --- Flights (Duffel) ---
	let flightStatus: LiveStatus;
	if (flightWindows.length === 0) flightStatus = "not_needed";
	else if (!env.DUFFEL_ACCESS_TOKEN) flightStatus = "not_configured";
	else {
		const token = env.DUFFEL_ACCESS_TOKEN;
		let failed = 0;
		try {
			const signal = AbortSignal.timeout(LIVE_TIMEOUT_MS);
			const [from, to] = await Promise.all([
				airportCodeNear(token, request.origin, signal),
				airportCodeNear(token, venue, signal),
			]);
			if (from && to && from !== to) {
				const results = await Promise.allSettled(
					flightWindows.map(async (w) => {
						const s = { from, to, out: w.check_in, back: w.check_out, adults: party };
						const offer = await cheapestRoundTrip(token, s, { ...opts, signal });
						if (offer) {
							flights.set(
								windowKey(w),
								flightItem(offer, s, request.origin, venue.city, fetchedAt),
							);
							currencies.add(offer.currency);
						}
					}),
				);
				failed = results.filter((r) => r.status === "rejected").length;
				for (const r of results)
					if (r.status === "rejected") console.warn("duffel offer failed", r.reason);
			}
		} catch (err) {
			console.warn("duffel unavailable", err);
			failed = flightWindows.length;
		}
		flightStatus = statusOf(flights.size, failed, flightWindows.length);
	}

	// --- Hotels (Booking.com) ---
	let hotelStatus: LiveStatus;
	if (hotelWindows.length === 0) hotelStatus = "not_needed";
	else if (!env.BOOKING_API_TOKEN || !env.BOOKING_AFFILIATE_ID) hotelStatus = "not_configured";
	else {
		const creds = {
			base: env.BOOKING_API_BASE,
			token: env.BOOKING_API_TOKEN,
			affiliateId: env.BOOKING_AFFILIATE_ID,
		};
		const signal = AbortSignal.timeout(LIVE_TIMEOUT_MS);
		const rooms = lodgingUnits("hotel", party);
		const results = await Promise.allSettled(
			hotelWindows.map(async (w) => {
				const s = {
					lat: venue.lat,
					lng: venue.lng,
					check_in: w.check_in,
					check_out: w.check_out,
					adults: party,
					rooms,
					currency: request.budget.currency,
					booker_country: request.origin.country_code,
				};
				const offer = await cheapestStay(creds, s, { ...opts, signal });
				if (!offer) return;
				const lines: CandidateItem[] = [stayItem(offer, s, w.nights, fetchedAt)];
				if (!offer.all_charges_included) {
					// Spec §5: hidden costs count. Booking.com said some charges are not in
					// this price, so keep an estimate for them.
					const tax = Math.ceil(offer.amount_minor * EST.lodgingTaxRate);
					lines.push({
						kind: "lodging",
						title: "Taxes and charges not in that price (estimated)",
						provider: "estimate",
						provider_ref: null,
						amount_minor: tax,
						currency: offer.currency,
						is_estimate: true,
						booking_url: null,
						fetched_at: fetchedAt,
						method: `${EST.lodgingTaxRate * 100}% of ${formatMoney(offer)}; Booking.com shows the exact charges before you book`,
					});
				}
				hotels.set(windowKey(w), lines);
				currencies.add(offer.currency);
			}),
		);
		const failed = results.filter((r) => r.status === "rejected").length;
		for (const r of results)
			if (r.status === "rejected") console.warn("booking.com search failed", r.reason);
		hotelStatus = statusOf(hotels.size, failed, hotelWindows.length);
	}

	return {
		live: { flights, hotels },
		status: { flights: flightStatus, hotels: hotelStatus },
		currencies,
	};
}
