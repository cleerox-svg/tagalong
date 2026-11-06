/**
 * Budget filter and ranking (spec §5). Deterministic code: the AI never
 * decides which packages are shown or in what order.
 *
 *  1. Hard filter: total ≤ budget, with a per-person budget turned into a
 *     total first. Over-budget packages are never shown.
 *  2. Score = weighted preference match, weights below in one place.
 *  3. Pick up to five packages, one per label, that differ from each other.
 *     A label with no eligible candidate is left out rather than padded with a
 *     near-copy, so a tight budget can return fewer than five.
 */
import type { Candidate, PackageLabel, Prefs, SeatTier, TripRequest } from "./types.js";

export const WEIGHTS = {
	transport: 3,
	stay: 2,
	seat: 2,
	vibe: 1,
	travelTime: 1.5,
	stayDistance: 0.5,
} as const;

/** Above this many one-way hours the travel-time score is 0. */
export const TRAVEL_HOURS_CAP = 12;

/** Budget as a total for the whole party, in minor units. */
export function budgetTotalMinor(budget: TripRequest["budget"], partySize: number): number {
	return budget.scope === "per_person" ? budget.amount_minor * partySize : budget.amount_minor;
}

export function withinBudget(c: Candidate, budgetTotal: number, currency: string): boolean {
	if (c.currency !== currency)
		throw new Error(`candidate ${c.id} is in ${c.currency}, budget is ${currency}`);
	return c.total_minor <= budgetTotal;
}

const TIER_RANK: Readonly<Record<SeatTier, number>> = { budget: 0, mid: 1, premium: 2 };

export interface ScoreBreakdown {
	transport: number;
	stay: number;
	seat: number;
	vibe: number;
	travelTime: number;
	stayDistance: number;
}

export function scoreParts(c: Candidate, prefs: Prefs): ScoreBreakdown {
	const transport = prefs.transport === "any" || prefs.transport === c.transport_mode ? 1 : 0.3;

	let stay: number;
	if (c.lodging_type === "none") stay = prefs.stay === "any" ? 1 : 0.8;
	else stay = prefs.stay === "any" || prefs.stay === c.lodging_type ? 1 : 0.3;

	let seat: number;
	if (prefs.seat_quality === "any") seat = [0.5, 0.75, 1][TIER_RANK[c.ticket_tier]] ?? 0.5;
	else {
		const gap = Math.abs(TIER_RANK[c.ticket_tier] - TIER_RANK[prefs.seat_quality]);
		seat = gap === 0 ? 1 : gap === 1 ? 0.6 : 0.3;
	}

	// Vibe tags are served by time at the destination: more nights, more of it.
	const wantsTime = prefs.vibe_tags.some((t) => t !== "budget-max");
	const vibe = !wantsTime ? 1 : c.nights === 0 ? 0.3 : c.nights === 1 ? 0.6 : 1;

	const travelTime = 1 - Math.min(c.travel_hours, TRAVEL_HOURS_CAP) / TRAVEL_HOURS_CAP;

	// Estimates price hotels near the venue; rentals and hostels tend to be further out.
	const stayDistance =
		c.lodging_type === "none" || c.lodging_type === "hotel"
			? 1
			: c.lodging_type === "hostel"
				? 0.8
				: 0.7;

	return { transport, stay, seat, vibe, travelTime, stayDistance };
}

/** Weighted preference match in [0, 1]. */
export function score(c: Candidate, prefs: Prefs): number {
	const p = scoreParts(c, prefs);
	let sum = 0;
	let weight = 0;
	for (const k of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) {
		sum += WEIGHTS[k] * p[k];
		weight += WEIGHTS[k];
	}
	return Math.round((sum / weight) * 10000) / 10000;
}

export interface RankedPackage {
	rank: number;
	label: PackageLabel;
	candidate: Candidate;
	score: number;
}

export interface RankResult {
	packages: RankedPackage[];
	considered: number;
	within_budget: number;
	budget_total_minor: number;
	/** The cheapest candidate's total, when nothing fits — "you'd need X". */
	cheapest_over_budget_minor: number | null;
}

/** Dimensions two packages can differ on. */
function differences(a: Candidate, b: Candidate): number {
	let d = 0;
	if (a.event_id !== b.event_id) d++;
	if (a.ticket_tier !== b.ticket_tier) d++;
	if (a.transport_mode !== b.transport_mode) d++;
	if (a.lodging_type !== b.lodging_type) d++;
	if (a.nights !== b.nights) d++;
	return d;
}

/** Stable order: better key first, then id so ties never depend on input order. */
function pick(
	pool: readonly Candidate[],
	chosen: readonly Candidate[],
	key: (c: Candidate) => number,
	filter: (c: Candidate) => boolean = () => true,
): Candidate | null {
	const eligible = pool.filter((c) => filter(c) && !chosen.some((x) => x.id === c.id));
	const sorted = [...eligible].sort(
		(a, b) => key(b) - key(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	// Prefer a package that differs from every chosen one on 2+ dimensions,
	// then accept 1. Never a duplicate.
	for (const need of [2, 1]) {
		const hit = sorted.find((c) => chosen.every((x) => differences(c, x) >= need));
		if (hit) return hit;
	}
	return null;
}

export function rankPackages(candidates: readonly Candidate[], request: TripRequest): RankResult {
	const budgetTotal = budgetTotalMinor(request.budget, request.party_size);
	const currency = request.budget.currency;
	const prefs = request.prefs;
	const pool = candidates.filter((c) => withinBudget(c, budgetTotal, currency));

	const scores = new Map(pool.map((c) => [c.id, score(c, prefs)] as const));
	const s = (c: Candidate) => scores.get(c.id) ?? 0;
	const primary = (c: Candidate) => !c.is_alternative_event;
	const budgetMax = prefs.vibe_tags.includes("budget-max");

	const chosen: Candidate[] = [];
	const out: RankedPackage[] = [];
	const take = (label: PackageLabel, c: Candidate | null) => {
		if (!c) return;
		chosen.push(c);
		out.push({ rank: out.length + 1, label, candidate: c, score: s(c) });
	};

	// Cheapest: lowest total; among equals, the better match.
	take(
		"cheapest",
		pick(pool, chosen, (c) => -c.total_minor + s(c) / 10, primary),
	);
	// Best value: score per share of budget spent.
	take(
		"best_value",
		pick(pool, chosen, (c) => s(c) / Math.max(c.total_minor / budgetTotal, 0.01), primary),
	);
	// Best experience: best seats and stay inside the budget. A "budget-max"
	// traveller still gets one, but the score decides rather than the seat tier.
	take(
		"best_experience",
		pick(pool, chosen, (c) => (budgetMax ? 0 : TIER_RANK[c.ticket_tier]) + s(c), primary),
	);
	// Make a weekend of it: an extra night beyond the minimum, best match.
	const minNights = Math.min(...pool.filter(primary).map((c) => c.nights), Infinity);
	take(
		"weekend",
		pick(pool, chosen, s, (c) => primary(c) && c.nights > minNights && c.nights >= 1),
	);
	// Alternative: a different date/game, or a transport mode not used yet.
	const usedModes = new Set(chosen.map((c) => c.transport_mode));
	take(
		"alternative",
		pick(pool, chosen, s, (c) => c.is_alternative_event || !usedModes.has(c.transport_mode)),
	);

	let cheapestOver: number | null = null;
	if (pool.length === 0 && candidates.length > 0) {
		cheapestOver = Math.min(...candidates.map((c) => c.total_minor));
	}

	return {
		packages: out,
		considered: candidates.length,
		within_budget: pool.length,
		budget_total_minor: budgetTotal,
		cheapest_over_budget_minor: cheapestOver,
	};
}
