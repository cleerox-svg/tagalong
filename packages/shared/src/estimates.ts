/**
 * Phase 1 estimate tables.
 *
 * These are NOT prices. They are coarse rules of thumb, used only where no
 * provider has given us a price yet (spec §2.1: "if there's no price, the app
 * says 'estimate' and shows how it got the number"). Every item built from
 * them is stored with `is_estimate = 1` and a `method` string that spells out
 * the arithmetic, and the UI labels it. Phase 2 replaces transport and lodging
 * with live provider prices.
 *
 * All amounts are USD major units; they are converted with a stored, dated FX
 * rate like any other price. Change a number here only with a reason in the
 * commit message, and bump ESTIMATES_VERSION.
 */
import type { SeatTier, StayType, TransportMode, VibeTag } from "./types.js";

export const ESTIMATES_VERSION = "2026-11-v1";
/** Date the table was last reviewed; shown as the estimate's "as of". */
export const ESTIMATES_AS_OF = "2026-11-06T00:00:00Z";
export const ESTIMATES_CURRENCY = "USD";

/**
 * Relative cost of a stay/meal/activity in a country, 1.0 = typical US/Canada
 * city. Deliberately coarse tiers rather than per-country figures: precision
 * here would be false precision.
 */
const COST_TIERS: ReadonlyArray<readonly [number, string]> = [
	[1.3, "CH NO IS DK LU IE MC"],
	[1.1, "GB SE FI NL AU NZ SG IL AE QA"],
	[1.0, "US CA FR DE BE AT JP HK IT"],
	[0.8, "ES PT GR KR TW SI EE CZ"],
	[0.65, "PL HU HR SK LT LV CL UY SA BH KW OM PA CR"],
	[0.5, "MX BR AR CO PE TR ZA MY TH CN RO BG RS MA DO JM"],
	[0.4, "IN ID VN PH EG KE NG PK BD LK NP KH LA BO EC GT HN NI SV PY"],
];
const COST_INDEX: ReadonlyMap<string, number> = new Map(
	COST_TIERS.flatMap(([idx, codes]) => codes.split(" ").map((c) => [c, idx] as const)),
);
export const DEFAULT_COST_INDEX = 0.8;

export function costIndex(countryCode: string): number {
	return COST_INDEX.get(countryCode) ?? DEFAULT_COST_INDEX;
}

/** Pump price, USD per litre, by tier. */
const FUEL_USD_PER_L: ReadonlyMap<string, number> = new Map([
	["US", 1.0],
	["CA", 1.2],
	["MX", 1.3],
]);
export const DEFAULT_FUEL_USD_PER_L = 1.8;
export function fuelUsdPerLitre(countryCode: string): number {
	return FUEL_USD_PER_L.get(countryCode) ?? DEFAULT_FUEL_USD_PER_L;
}

export const EST = {
	/** Straight-line km × this ≈ road km. */
	roadFactor: 1.25,
	driveKmh: 85,
	/** Longest one-way drive offered. */
	maxDriveKm: 1300,
	borderCrossingHours: 1,
	litresPer100Km: 8.5,
	carSeats: 5,
	tollUsdPerKm: 0.02,
	eventParkingUsd: 30,
	overnightParkingUsdPerNight: 25,

	minFlyKm: 250,
	flyKmh: 750,
	/** Check-in, security, transfers at both ends. */
	flyOverheadHours: 3,
	/** Round-trip economy fare per person = base + perKm × straight-line km. */
	fareBaseUsd: 90,
	fareUsdPerKm: 0.12,
	/** Per party, per leg (airport ↔ city), 4 legs per round trip. */
	airportTransferUsdPerLeg: 35,

	minGroundKm: 50,
	maxGroundKm: 700,
	trainUsdPerKm: 0.15,
	trainKmh: 90,
	busUsdPerKm: 0.08,
	busKmh: 70,
	groundOverheadHours: 0.5,

	/** One-way travel above this needs a night; above longHaul, two. */
	dayTripMaxHours: 3.5,
	longHaulHours: 12,

	hotelRoomUsdPerNight: 160,
	hotelGuestsPerRoom: 2,
	rentalUsdPerNight: 200,
	rentalGuestsPerUnit: 6,
	hostelBedUsdPerNight: 40,
	lodgingTaxRate: 0.15,

	foodUsdPerPersonPerDay: 50,

	/** Ticket fees on top of face value. */
	ticketFeeRate: 0.25,
} as const;

/** Per person per night at the destination, USD, before the cost index. */
export const ACTIVITY_USD: Readonly<Record<VibeTag, number>> = {
	food: 0, // covered by the food allowance
	nightlife: 40,
	sightseeing: 25,
	outdoors: 15,
	family: 20,
	"budget-max": 0,
};

/**
 * Typical face value per ticket when the provider lists no price, USD, by
 * Ticketmaster segment. Used only as a labelled fallback.
 */
const TICKET_FALLBACK_USD: Readonly<Record<string, number>> = {
	Sports: 90,
	Music: 110,
	"Arts & Theatre": 80,
};
export const TICKET_FALLBACK_DEFAULT_USD = 75;
export const TICKET_TIER_MULTIPLIER: Readonly<Record<SeatTier, number>> = {
	budget: 1,
	mid: 1.8,
	premium: 3.5,
};

export function ticketFallbackUsd(category: string | null): number {
	return (category && TICKET_FALLBACK_USD[category]) || TICKET_FALLBACK_DEFAULT_USD;
}

export function lodgingUnits(stay: StayType, party: number): number {
	switch (stay) {
		case "hotel":
			return Math.ceil(party / EST.hotelGuestsPerRoom);
		case "rental":
			return Math.ceil(party / EST.rentalGuestsPerUnit);
		case "hostel":
			return party;
	}
}

export function lodgingUsdPerUnitNight(stay: StayType): number {
	switch (stay) {
		case "hotel":
			return EST.hotelRoomUsdPerNight;
		case "rental":
			return EST.rentalUsdPerNight;
		case "hostel":
			return EST.hostelBedUsdPerNight;
	}
}

export interface TravelEstimate {
	mode: TransportMode;
	oneWayHours: number;
	/** km used for pricing (road km for ground modes, straight-line for fly). */
	km: number;
}

/** Which modes are offered for a trip, and how long each takes one way. */
export function travelOptions(
	straightKm: number,
	drivable: boolean,
	international: boolean,
): TravelEstimate[] {
	const out: TravelEstimate[] = [];
	const roadKm = straightKm * EST.roadFactor;
	if (drivable && roadKm <= EST.maxDriveKm) {
		out.push({
			mode: "drive",
			km: roadKm,
			oneWayHours: roadKm / EST.driveKmh + (international ? EST.borderCrossingHours : 0),
		});
	}
	if (straightKm >= EST.minFlyKm) {
		out.push({
			mode: "fly",
			km: straightKm,
			oneWayHours: straightKm / EST.flyKmh + EST.flyOverheadHours,
		});
	}
	if (drivable && straightKm >= EST.minGroundKm && straightKm <= EST.maxGroundKm) {
		const border = international ? EST.borderCrossingHours : 0;
		out.push({
			mode: "train",
			km: roadKm,
			oneWayHours: roadKm / EST.trainKmh + EST.groundOverheadHours + border,
		});
		out.push({
			mode: "bus",
			km: roadKm,
			oneWayHours: roadKm / EST.busKmh + EST.groundOverheadHours + border,
		});
	}
	return out;
}

/** Minimum nights a trip of this length needs. */
export function baseNights(oneWayHours: number): number {
	if (oneWayHours > EST.longHaulHours) return 2;
	if (oneWayHours > EST.dayTripMaxHours) return 1;
	return 0;
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
