/**
 * Builds every candidate package for one event: ticket tier × transport mode ×
 * stay type × nights. Pure: no I/O. Totals are converted to the budget
 * currency here so ranking.ts only ever compares like with like.
 */
import {
	ACTIVITY_USD,
	baseNights,
	costIndex,
	EST,
	ESTIMATES_AS_OF,
	ESTIMATES_CURRENCY,
	fuelUsdPerLitre,
	lodgingUnits,
	lodgingUsdPerUnitNight,
	round1,
	TICKET_TIER_MULTIPLIER,
	ticketFallbackUsd,
	travelOptions,
	type TravelEstimate,
} from "./estimates.js";
import { addDays, canDriveBetween, haversineKm } from "./geo.js";
import { formatMoney, type FxTable, majorToMinor } from "./money.js";
import {
	type Candidate,
	type CandidateItem,
	type EventInfo,
	type LodgingType,
	type Place,
	type SeatTier,
	STAY_TYPES,
	type TripRequest,
} from "./types.js";

export interface Venue {
	lat: number;
	lng: number;
	country_code: string;
	city: string;
}

export interface BuildInput {
	request: TripRequest;
	event: EventInfo;
	/** Our events.id for this event. */
	event_id: string;
	venue: Venue;
	is_alternative_event: boolean;
	fx: FxTable;
	/** When the provider data (event, prices) was fetched. */
	fetched_at: string;
}

const usd = (major: number): { amount_minor: number; currency: string } => ({
	amount_minor: majorToMinor(major, ESTIMATES_CURRENCY),
	currency: ESTIMATES_CURRENCY,
});

const fmtUsd = (major: number) => formatMoney(usd(major));

function estimate(
	kind: CandidateItem["kind"],
	title: string,
	usdMajor: number,
	method: string,
	booking_url: string | null,
): CandidateItem {
	return {
		kind,
		title,
		provider: "estimate",
		provider_ref: null,
		...usd(usdMajor),
		is_estimate: true,
		booking_url,
		fetched_at: ESTIMATES_AS_OF,
		method,
	};
}

const enc = encodeURIComponent;

function ticketItems(input: BuildInput): Map<SeatTier, CandidateItem[]> {
	const { event, request } = input;
	const party = request.party_size;
	const out = new Map<SeatTier, CandidateItem[]>();
	const pr = event.price_range;
	const url = event.url;

	const feeItem = (faceTotal: { amount_minor: number; currency: string }): CandidateItem => ({
		kind: "ticket",
		title: "Ticket fees (estimated)",
		provider: "estimate",
		provider_ref: null,
		amount_minor: Math.ceil(faceTotal.amount_minor * EST.ticketFeeRate),
		currency: faceTotal.currency,
		is_estimate: true,
		booking_url: null,
		fetched_at: ESTIMATES_AS_OF,
		method: `${EST.ticketFeeRate * 100}% of face value (${formatMoney(faceTotal)}); the seller shows the real fees at checkout`,
	});

	if (pr && pr.max_minor >= pr.min_minor && pr.min_minor > 0) {
		const tiers: Array<[SeatTier, number, boolean]> = [["budget", pr.min_minor, false]];
		if (pr.max_minor > pr.min_minor) {
			tiers.push(["mid", Math.ceil((pr.min_minor + pr.max_minor) / 2), true]);
			tiers.push(["premium", pr.max_minor, false]);
		}
		for (const [tier, each, interpolated] of tiers) {
			const face = { amount_minor: each * party, currency: pr.currency };
			const eachStr = formatMoney({ amount_minor: each, currency: pr.currency });
			out.set(tier, [
				{
					kind: "ticket",
					title: `${party} × ${tier} ticket${party > 1 ? "s" : ""} — ${event.name}`,
					provider: "ticketmaster",
					provider_ref: event.provider_event_id,
					...face,
					is_estimate: interpolated,
					booking_url: url,
					fetched_at: input.fetched_at,
					method: interpolated
						? `Midpoint of Ticketmaster's listed face-value range: ${eachStr} each × ${party}`
						: `Ticketmaster listed face value: ${eachStr} each × ${party}`,
				},
				feeItem(face),
			]);
		}
		return out;
	}

	const base = ticketFallbackUsd(event.category);
	for (const tier of ["budget", "mid", "premium"] as const) {
		const each = base * TICKET_TIER_MULTIPLIER[tier];
		const faceUsd = each * party;
		out.set(tier, [
			estimate(
				"ticket",
				`${party} × ${tier} ticket${party > 1 ? "s" : ""} — ${event.name} (no price listed)`,
				faceUsd,
				`Ticketmaster lists no price for this event. Typical ${event.category ?? "event"} face value ${fmtUsd(base)} × ${TICKET_TIER_MULTIPLIER[tier]} for ${tier} seats = ${fmtUsd(each)} each × ${party}`,
				url,
			),
			feeItem(usd(faceUsd)),
		]);
	}
	return out;
}

function transportItems(
	t: TravelEstimate,
	input: BuildInput,
	nights: number,
	checkIn: string,
	checkOut: string,
): CandidateItem[] {
	const { request, venue } = input;
	const party = request.party_size;
	const origin = request.origin;
	const km = Math.round(t.km);
	const mapsDir = (mode: string) =>
		`https://www.google.com/maps/dir/?api=1&origin=${enc(origin.label)}&destination=${enc(`${input.event.venue_name ?? ""} ${venue.city}`.trim())}&travelmode=${mode}`;

	switch (t.mode) {
		case "drive": {
			const cars = Math.ceil(party / EST.carSeats);
			const fuelPrice = fuelUsdPerLitre(origin.country_code);
			const litres = ((km * 2) / 100) * EST.litresPer100Km * cars;
			const tolls = km * 2 * EST.tollUsdPerKm * cars;
			const parking = (EST.eventParkingUsd + EST.overnightParkingUsdPerNight * nights) * cars;
			const carNote = cars > 1 ? ` × ${cars} cars` : "";
			return [
				estimate(
					"transport",
					`Gas — drive ~${km} km each way`,
					litres * fuelPrice,
					`${km * 2} road km round trip at ${EST.litresPer100Km} L/100 km × ${fmtUsd(fuelPrice)}/L${carNote}. Road km ≈ straight-line × ${EST.roadFactor}`,
					mapsDir("driving"),
				),
				estimate(
					"transport",
					"Tolls (estimated)",
					tolls,
					`${km * 2} km × ${fmtUsd(EST.tollUsdPerKm)}/km${carNote}`,
					null,
				),
				estimate(
					"transport",
					"Parking (estimated)",
					parking,
					`Event parking ${fmtUsd(EST.eventParkingUsd)} + ${nights} night${nights === 1 ? "" : "s"} × ${fmtUsd(EST.overnightParkingUsdPerNight)}${carNote}`,
					null,
				),
			];
		}
		case "fly": {
			const fare = EST.fareBaseUsd + EST.fareUsdPerKm * km;
			const transfers = EST.airportTransferUsdPerLeg * 4;
			return [
				estimate(
					"transport",
					`Round-trip flights × ${party}`,
					fare * party,
					`${fmtUsd(EST.fareBaseUsd)} + ${fmtUsd(EST.fareUsdPerKm)} × ${km} km straight-line = ${fmtUsd(fare)} per person, economy`,
					`https://www.google.com/travel/flights?q=${enc(`Flights to ${venue.city} from ${origin.label} on ${checkIn} through ${checkOut}`)}`,
				),
				estimate(
					"transport",
					"Airport transfers",
					transfers,
					`4 legs (airport ↔ city, both ends) × ${fmtUsd(EST.airportTransferUsdPerLeg)} per party`,
					null,
				),
			];
		}
		case "train":
		case "bus": {
			const rate = t.mode === "train" ? EST.trainUsdPerKm : EST.busUsdPerKm;
			return [
				estimate(
					"transport",
					`Round-trip ${t.mode} × ${party} (if a route runs)`,
					km * 2 * rate * party,
					`${km * 2} km × ${fmtUsd(rate)}/km per person. Check that a ${t.mode} route exists`,
					mapsDir("transit"),
				),
			];
		}
	}
}

function lodgingItems(
	stay: LodgingType,
	input: BuildInput,
	nights: number,
	checkIn: string,
	checkOut: string,
): CandidateItem[] {
	if (stay === "none" || nights === 0) return [];
	const { request, venue } = input;
	const party = request.party_size;
	const idx = costIndex(venue.country_code);
	const units = lodgingUnits(stay, party);
	const perUnit = lodgingUsdPerUnitNight(stay) * idx;
	const base = perUnit * units * nights;
	const unitWord = stay === "hotel" ? "room" : stay === "rental" ? "unit" : "bed";
	const url =
		stay === "rental"
			? `https://www.airbnb.com/s/${enc(venue.city)}/homes?checkin=${checkIn}&checkout=${checkOut}&adults=${party}`
			: `https://www.booking.com/searchresults.html?ss=${enc(`${venue.city}${stay === "hostel" ? " hostel" : ""}`)}&checkin=${checkIn}&checkout=${checkOut}&group_adults=${party}&no_rooms=${units}`;
	return [
		estimate(
			"lodging",
			`${stay[0]?.toUpperCase()}${stay.slice(1)} — ${nights} night${nights > 1 ? "s" : ""}, ${units} ${unitWord}${units > 1 ? "s" : ""}`,
			base,
			`${fmtUsd(lodgingUsdPerUnitNight(stay))}/${unitWord}/night × cost index ${idx} for ${venue.country_code} × ${units} × ${nights}`,
			url,
		),
		estimate(
			"lodging",
			"Lodging taxes (estimated)",
			base * EST.lodgingTaxRate,
			`${EST.lodgingTaxRate * 100}% of the stay`,
			null,
		),
	];
}

function extrasItems(input: BuildInput, nights: number): CandidateItem[] {
	const { request, venue } = input;
	const party = request.party_size;
	const idx = costIndex(venue.country_code);
	const days = nights + 1;
	const foodPerDay = EST.foodUsdPerPersonPerDay * idx;
	const out: CandidateItem[] = [
		estimate(
			"food",
			`Food allowance — ${days} day${days > 1 ? "s" : ""}`,
			foodPerDay * party * days,
			`${fmtUsd(foodPerDay)} per person per day (${fmtUsd(EST.foodUsdPerPersonPerDay)} × cost index ${idx}) × ${party} × ${days}`,
			`https://www.google.com/maps/search/${enc(`restaurants near ${input.event.venue_name ?? venue.city}`)}`,
		),
	];
	const tags = request.prefs.vibe_tags.filter((t) => ACTIVITY_USD[t] > 0);
	if (nights > 0 && tags.length > 0) {
		const perNight = tags.reduce((s, t) => s + ACTIVITY_USD[t], 0) * idx;
		out.push(
			estimate(
				"activity",
				`Things to do: ${tags.join(", ")}`,
				perNight * party * nights,
				`${tags.map((t) => `${t} ${fmtUsd(ACTIVITY_USD[t])}`).join(" + ")} per person per night × cost index ${idx} × ${party} × ${nights}`,
				`https://www.google.com/maps/search/${enc(`${tags[0]} in ${venue.city}`)}`,
			),
		);
	}
	return out;
}

export function buildCandidates(input: BuildInput): Candidate[] {
	const { request, event, venue, fx } = input;
	const origin: Place = request.origin;
	const straightKm = haversineKm(origin, venue);
	const international = origin.country_code !== venue.country_code;
	const drivable = canDriveBetween(origin.country_code, venue.country_code);
	const options = travelOptions(straightKm, drivable, international);
	const tickets = ticketItems(input);
	const maxNights = request.prefs.max_nights;
	const out: Candidate[] = [];

	// Already at the venue (same city): no transport line, a local day out.
	if (options.length === 0 && straightKm < EST.minGroundKm) {
		options.push({
			mode: "drive",
			km: straightKm * EST.roadFactor,
			oneWayHours: (straightKm * EST.roadFactor) / 40,
		});
	}

	for (const t of options) {
		const minNights = baseNights(t.oneWayHours);
		if (minNights > maxNights) continue;
		const nightOptions = [...new Set([minNights, Math.max(1, minNights), minNights + 1])].filter(
			(n) => n <= maxNights,
		);
		for (const nights of nightOptions) {
			const checkIn = addDays(event.local_date, -Math.max(0, nights - 1));
			const checkOut = addDays(checkIn, Math.max(1, nights));
			const stays: LodgingType[] = nights === 0 ? ["none"] : [...STAY_TYPES];
			for (const stay of stays) {
				for (const [tier, ticketLines] of tickets) {
					const items = [
						...ticketLines,
						...transportItems(t, input, nights, checkIn, checkOut),
						...lodgingItems(stay, input, nights, checkIn, checkOut),
						...extrasItems(input, nights),
					];
					let total = 0;
					for (const it of items) {
						total += fx.convert(
							{ amount_minor: it.amount_minor, currency: it.currency },
							request.budget.currency,
						).amount_minor;
					}
					out.push({
						id: `${input.event_id}|${tier}|${t.mode}|${stay}|${nights}`,
						event_id: input.event_id,
						is_alternative_event: input.is_alternative_event,
						ticket_tier: tier,
						transport_mode: t.mode,
						lodging_type: stay,
						nights,
						travel_hours: round1(t.oneWayHours),
						international,
						items,
						total_minor: total,
						currency: request.budget.currency,
					});
				}
			}
		}
	}
	return out;
}
