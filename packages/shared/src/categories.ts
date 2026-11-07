/**
 * Category browse (spec §9 phase 4: "gaming events near X in May"). Each of
 * our categories maps to one Ticketmaster Discovery search: a classification
 * where Ticketmaster has one, otherwise a keyword. Kept in one place so the
 * app, the parse step and the API agree on the list.
 */

export const EVENT_CATEGORY_IDS = [
	"sports",
	"concerts",
	"theatre",
	"comedy",
	"family",
	"festivals",
	"gaming",
	"car-shows",
	"conventions",
] as const;
export type EventCategoryId = (typeof EVENT_CATEGORY_IDS)[number];

export interface EventCategory {
	id: EventCategoryId;
	label: string;
	/** Exactly one of these is set. */
	ticketmaster: { classificationName: string } | { keyword: string };
}

export const EVENT_CATEGORIES: readonly EventCategory[] = [
	{ id: "sports", label: "Sports", ticketmaster: { classificationName: "Sports" } },
	{ id: "concerts", label: "Concerts", ticketmaster: { classificationName: "Music" } },
	{
		id: "theatre",
		label: "Theatre & arts",
		ticketmaster: { classificationName: "Arts & Theatre" },
	},
	{ id: "comedy", label: "Comedy", ticketmaster: { classificationName: "Comedy" } },
	{ id: "family", label: "Family", ticketmaster: { classificationName: "Family" } },
	{ id: "festivals", label: "Festivals", ticketmaster: { keyword: "festival" } },
	{ id: "gaming", label: "Gaming & esports", ticketmaster: { keyword: "gaming" } },
	{ id: "car-shows", label: "Car & import shows", ticketmaster: { keyword: "car show" } },
	{ id: "conventions", label: "Conventions & expos", ticketmaster: { keyword: "convention" } },
];

export function eventCategory(id: string): EventCategory | undefined {
	return EVENT_CATEGORIES.find((c) => c.id === id);
}

export const BROWSE_RADIUS_KM = [25, 50, 100, 250] as const;
/** Ticketmaster returns at most this many per page; one page is enough to pick from. */
export const BROWSE_PAGE_SIZE = 20;
/** A longer window returns mostly noise and is slower. */
export const BROWSE_MAX_DAYS = 366;

const GEOHASH = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * Geohash of a point, which Ticketmaster's `geoPoint` parameter takes. Origins
 * are city centres already, so a 7-character hash (~150 m) gives nothing away.
 */
export function geohash(lat: number, lng: number, precision = 7): string {
	let latLo = -90;
	let latHi = 90;
	let lngLo = -180;
	let lngHi = 180;
	let out = "";
	let bits = 0;
	let ch = 0;
	let even = true;
	while (out.length < precision) {
		if (even) {
			const mid = (lngLo + lngHi) / 2;
			if (lng >= mid) {
				ch = (ch << 1) | 1;
				lngLo = mid;
			} else {
				ch <<= 1;
				lngHi = mid;
			}
		} else {
			const mid = (latLo + latHi) / 2;
			if (lat >= mid) {
				ch = (ch << 1) | 1;
				latLo = mid;
			} else {
				ch <<= 1;
				latHi = mid;
			}
		}
		even = !even;
		if (++bits === 5) {
			out += GEOHASH[ch];
			bits = 0;
			ch = 0;
		}
	}
	return out;
}

/**
 * Maps a provider's own category name onto the Ticketmaster segment names the
 * ticket-price fallback table uses (estimates.ts), or keeps it as given.
 */
export function normaliseCategory(name: string | null | undefined): string | null {
	if (!name) return null;
	const n = name.trim();
	if (!n) return null;
	const lower = n.toLowerCase();
	if (/\bmusic|concert/.test(lower)) return "Music";
	if (/\bsport|fitness|game\b|match/.test(lower)) return "Sports";
	if (/theat|perform|visual arts|arts\b|comedy|dance/.test(lower)) return "Arts & Theatre";
	return n.slice(0, 60);
}
