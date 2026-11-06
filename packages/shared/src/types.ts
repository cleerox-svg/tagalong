import { z } from "zod";
import { CURRENCY_RE } from "./money.js";

export const TRANSPORT_MODES = ["drive", "fly", "train", "bus"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

export const STAY_TYPES = ["hotel", "rental", "hostel"] as const;
export type StayType = (typeof STAY_TYPES)[number];
/** A day trip has no stay. */
export type LodgingType = StayType | "none";

export const SEAT_TIERS = ["budget", "mid", "premium"] as const;
export type SeatTier = (typeof SEAT_TIERS)[number];

export const VIBE_TAGS = [
	"food",
	"nightlife",
	"sightseeing",
	"outdoors",
	"family",
	"budget-max",
] as const;
export type VibeTag = (typeof VIBE_TAGS)[number];

export const PACKAGE_LABELS = [
	"cheapest",
	"best_value",
	"best_experience",
	"weekend",
	"alternative",
] as const;
export type PackageLabel = (typeof PACKAGE_LABELS)[number];

export const ITEM_KINDS = ["ticket", "transport", "lodging", "activity", "food"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const currency = z.string().regex(CURRENCY_RE, "ISO 4217 code");
const countryCode = z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2");

/** A resolved place. Origins are city-level; nothing finer is stored. */
export const PlaceSchema = z.object({
	label: z.string().min(1).max(200),
	lat: z.number().min(-90).max(90),
	lng: z.number().min(-180).max(180),
	country_code: countryCode,
});
export type Place = z.infer<typeof PlaceSchema>;

export const PrefsSchema = z.object({
	transport: z.enum([...TRANSPORT_MODES, "any"]),
	stay: z.enum([...STAY_TYPES, "any"]),
	max_nights: z.number().int().min(0).max(7),
	seat_quality: z.enum([...SEAT_TIERS, "any"]),
	vibe_tags: z.array(z.enum(VIBE_TAGS)).max(VIBE_TAGS.length),
	accessibility: z.string().max(500).optional(),
});
export type Prefs = z.infer<typeof PrefsSchema>;

/**
 * A confirmed trip request: what the user saw and accepted before a planning
 * run starts. Every field is required here; the parse step's output is the
 * looser `ParsedTripRequest`.
 */
export const TripRequestSchema = z
	.object({
		raw_text: z.string().max(2000).optional(),
		origin: PlaceSchema,
		event: z.object({
			query: z.string().min(1).max(200),
			city: z.string().max(100).optional(),
			/** Pin one Ticketmaster event (e.g. "plan this date instead"). */
			ticketmaster_event_id: z
				.string()
				.regex(/^[A-Za-z0-9_-]{1,64}$/)
				.optional(),
		}),
		date_from: isoDate,
		date_to: isoDate,
		party_size: z.number().int().min(1).max(20),
		budget: z.object({
			amount_minor: z.number().int().positive().max(1e12),
			currency,
			scope: z.enum(["total", "per_person"]),
		}),
		prefs: PrefsSchema,
	})
	.refine((r) => r.date_from <= r.date_to, {
		message: "date_from must not be after date_to",
		path: ["date_to"],
	});
export type TripRequest = z.infer<typeof TripRequestSchema>;

/**
 * What the free-text parse step may return. Everything is nullable: the user
 * fills the gaps in the confirm form. Claude never produces a price here — a
 * budget is the user's own number, read from their text.
 */
export const ParsedTripRequestSchema = z.object({
	origin_text: z.string().max(200).nullable(),
	event_query: z.string().max(200).nullable(),
	event_city: z.string().max(100).nullable(),
	date_from: isoDate.nullable(),
	date_to: isoDate.nullable(),
	party_size: z.number().int().min(1).max(20).nullable(),
	budget_amount: z
		.string()
		.regex(/^\d+(\.\d{1,3})?$/)
		.nullable(),
	budget_currency: currency.nullable(),
	budget_scope: z.enum(["total", "per_person"]).nullable(),
	transport: z.enum([...TRANSPORT_MODES, "any"]).nullable(),
	stay: z.enum([...STAY_TYPES, "any"]).nullable(),
	max_nights: z.number().int().min(0).max(7).nullable(),
	seat_quality: z.enum([...SEAT_TIERS, "any"]).nullable(),
	vibe_tags: z.array(z.enum(VIBE_TAGS)),
	accessibility: z.string().max(500).nullable(),
});
export type ParsedTripRequest = z.infer<typeof ParsedTripRequestSchema>;

/** Our own event shape; provider adapters map into it. */
export interface EventInfo {
	provider: "ticketmaster";
	provider_event_id: string;
	name: string;
	category: string | null;
	venue_name: string | null;
	city: string | null;
	country_code: string | null;
	lat: number | null;
	lng: number | null;
	/** Local date at the venue, YYYY-MM-DD. */
	local_date: string;
	starts_at: string | null;
	url: string | null;
	/** Face-value range from the provider, if it lists one. */
	price_range: { min_minor: number; max_minor: number; currency: string } | null;
}

/** One line of a package, in its source currency. */
export interface CandidateItem {
	kind: ItemKind;
	title: string;
	provider: string;
	provider_ref: string | null;
	amount_minor: number;
	currency: string;
	is_estimate: boolean;
	booking_url: string | null;
	/** ISO timestamp of the provider response, or of the estimate table. */
	fetched_at: string;
	/** How the number was reached. Always set for estimates. */
	method: string;
}

export interface Candidate {
	id: string;
	event_id: string;
	is_alternative_event: boolean;
	ticket_tier: SeatTier;
	transport_mode: TransportMode;
	lodging_type: LodgingType;
	nights: number;
	/** Travel out / stay from (YYYY-MM-DD). Equal to the event date for a day trip. */
	check_in: string;
	/** Travel back / leave (YYYY-MM-DD). */
	check_out: string;
	/** One-way door-to-door hours. */
	travel_hours: number;
	international: boolean;
	items: CandidateItem[];
	/** Sum of items converted to the budget currency, rounded up per item. */
	total_minor: number;
	currency: string;
}
