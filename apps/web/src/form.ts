/**
 * The confirm form: what the user sees and edits before a run starts (spec
 * §5). Pure functions so they can be tested without a browser.
 */
import {
	isCurrencyCode,
	type ParsedTripRequest,
	parseMajor,
	type PinnedEvent,
	type Place,
	type Prefs,
	type TripRequest,
	TripRequestSchema,
	type VibeTag,
} from "@tagalong/shared";

export interface FormState {
	raw_text: string;
	origin_text: string;
	origin: Place | null;
	event_query: string;
	event_city: string;
	date_from: string;
	date_to: string;
	party_size: string;
	budget_amount: string;
	budget_currency: string;
	budget_scope: "total" | "per_person";
	transport: Prefs["transport"];
	stay: Prefs["stay"];
	max_nights: string;
	seat_quality: Prefs["seat_quality"];
	vibe_tags: VibeTag[];
	accessibility: string;
	/** An event picked from a link or a browse: the run plans exactly this one. */
	pinned?: PinnedEvent | undefined;
	/** No provider has the event: plan from its name, city and one date. */
	manual: boolean;
}

export function emptyForm(currency: string): FormState {
	return {
		raw_text: "",
		origin_text: "",
		origin: null,
		event_query: "",
		event_city: "",
		date_from: "",
		date_to: "",
		party_size: "1",
		budget_amount: "",
		budget_currency: currency,
		budget_scope: "total",
		transport: "any",
		stay: "any",
		max_nights: "2",
		seat_quality: "any",
		vibe_tags: [],
		accessibility: "",
		manual: false,
	};
}

/** Fills the form from parsed text. Fields the parse left null keep what the user had. */
export function applyParsed(f: FormState, p: ParsedTripRequest, raw: string): FormState {
	const next: FormState = { ...f, raw_text: raw };
	if (p.origin_text && p.origin_text !== f.origin_text) {
		next.origin_text = p.origin_text;
		next.origin = null; // a new city must be looked up and confirmed
	}
	if (p.event_query && p.event_query !== f.event_query) {
		next.event_query = p.event_query;
		// A different event: drop the one picked before.
		next.pinned = undefined;
		next.manual = false;
	}
	if (p.event_city) next.event_city = p.event_city;
	if (p.date_from) next.date_from = p.date_from;
	if (p.date_to) next.date_to = p.date_to;
	if (p.date_from && !p.date_to) next.date_to = p.date_from;
	if (p.party_size) next.party_size = String(p.party_size);
	if (p.budget_amount) next.budget_amount = p.budget_amount;
	if (p.budget_currency) next.budget_currency = p.budget_currency;
	if (p.budget_scope) next.budget_scope = p.budget_scope;
	if (p.transport) next.transport = p.transport;
	if (p.stay) next.stay = p.stay;
	if (p.max_nights !== null) next.max_nights = String(p.max_nights);
	if (p.seat_quality) next.seat_quality = p.seat_quality;
	if (p.vibe_tags.length) next.vibe_tags = p.vibe_tags;
	if (p.accessibility) next.accessibility = p.accessibility;
	return next;
}

/** The picked event fills the event fields; the run plans exactly this one. */
export function pinEvent(
	f: FormState,
	e: { pinned: PinnedEvent; name: string; city: string | null; local_date: string },
): FormState {
	return {
		...f,
		pinned: e.pinned,
		manual: false,
		event_query: e.name.slice(0, 200),
		event_city: (e.city ?? "").slice(0, 100),
		date_from: e.local_date,
		date_to: e.local_date,
	};
}

/** "Tell us the date and city": no provider has it, so the user describes it. */
export function describeEvent(f: FormState, title: string | null): FormState {
	return {
		...f,
		pinned: undefined,
		manual: true,
		event_query: (title ?? f.event_query).slice(0, 200),
		date_to: f.date_from,
	};
}

/** Back to searching by name and dates. */
export function unpinEvent(f: FormState): FormState {
	return { ...f, pinned: undefined, manual: false };
}

export type FormResult =
	{ ok: true; request: TripRequest } | { ok: false; errors: Record<string, string> };

export function toTripRequest(f: FormState): FormResult {
	const errors: Record<string, string> = {};
	if (!f.origin) errors.origin = "Pick your starting city from the list.";
	if (!f.event_query.trim())
		errors.event_query = f.manual ? "What's the event called?" : "What do you want to see?";
	if (!f.date_from) errors.date_from = f.manual ? "When is it?" : "Pick a date.";
	if (f.manual && !f.event_city.trim()) errors.event_city = "Which city is it in?";
	// A described event is one date: the run plans around exactly that day.
	const dateTo = f.manual ? f.date_from : f.date_to;
	if (!dateTo) errors.date_to = "Pick a date.";
	if (f.date_from && dateTo && f.date_from > dateTo)
		errors.date_to = "The end is before the start.";
	const party = Number(f.party_size);
	if (!Number.isInteger(party) || party < 1 || party > 20) errors.party_size = "1 to 20 people.";
	const currency = f.budget_currency.trim().toUpperCase();
	let amount = 0;
	if (!isCurrencyCode(currency)) errors.budget_currency = "A 3-letter currency code, like CAD.";
	else {
		try {
			amount = parseMajor(f.budget_amount, currency);
			if (amount <= 0) errors.budget_amount = "Enter your budget.";
		} catch {
			errors.budget_amount = "Enter an amount like 1200 or 1200.50.";
		}
	}
	const nights = Number(f.max_nights);
	if (!Number.isInteger(nights) || nights < 0 || nights > 7) errors.max_nights = "0 to 7 nights.";
	if (Object.keys(errors).length > 0 || !f.origin) return { ok: false, errors };

	const candidate = {
		...(f.raw_text.trim() ? { raw_text: f.raw_text.trim().slice(0, 2000) } : {}),
		origin: f.origin,
		event: {
			query: f.event_query.trim(),
			...(f.event_city.trim() ? { city: f.event_city.trim() } : {}),
			...(f.pinned && !f.manual ? { pinned: f.pinned } : {}),
			...(f.manual ? { manual: true } : {}),
		},
		date_from: f.date_from,
		date_to: dateTo,
		party_size: party,
		budget: { amount_minor: amount, currency, scope: f.budget_scope },
		prefs: {
			transport: f.transport,
			stay: f.stay,
			max_nights: nights,
			seat_quality: f.seat_quality,
			vibe_tags: f.vibe_tags,
			...(f.accessibility.trim() ? { accessibility: f.accessibility.trim() } : {}),
		},
	};
	const checked = TripRequestSchema.safeParse(candidate);
	if (!checked.success) {
		return { ok: false, errors: { form: checked.error.issues.map((i) => i.message).join("; ") } };
	}
	return { ok: true, request: checked.data };
}
