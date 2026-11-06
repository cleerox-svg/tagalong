import { describe, expect, it } from "vitest";
import { budgetTotalMinor, rankPackages, score, WEIGHTS } from "./ranking.js";
import type { Candidate, TripRequest } from "./types.js";

const request = (over: Partial<TripRequest> = {}): TripRequest => ({
	origin: { label: "Toronto, ON, Canada", lat: 43.65, lng: -79.38, country_code: "CA" },
	event: { query: "Knicks" },
	date_from: "2027-03-01",
	date_to: "2027-03-31",
	party_size: 2,
	budget: { amount_minor: 120000, currency: "CAD", scope: "total" },
	prefs: {
		transport: "drive",
		stay: "any",
		max_nights: 3,
		seat_quality: "any",
		vibe_tags: ["food", "nightlife"],
	},
	...over,
});

let n = 0;
const cand = (over: Partial<Candidate>): Candidate => {
	const c: Candidate = {
		id: "",
		event_id: "e1",
		is_alternative_event: false,
		ticket_tier: "budget",
		transport_mode: "drive",
		lodging_type: "hotel",
		nights: 1,
		check_in: "2027-03-12",
		check_out: "2027-03-13",
		travel_hours: 8,
		international: true,
		items: [],
		total_minor: 50000,
		currency: "CAD",
		...over,
	};
	c.id =
		c.id ||
		`${c.event_id}|${c.ticket_tier}|${c.transport_mode}|${c.lodging_type}|${c.nights}|${n++}`;
	return c;
};

const grid = (): Candidate[] => {
	const out: Candidate[] = [];
	const tierCost = { budget: 20000, mid: 40000, premium: 70000 };
	const modeCost = { drive: 15000, fly: 60000, bus: 10000, train: 20000 };
	const stayCost = { hotel: 25000, rental: 30000, hostel: 8000, none: 0 };
	for (const tier of ["budget", "mid", "premium"] as const)
		for (const mode of ["drive", "fly", "bus", "train"] as const)
			for (const stay of ["hotel", "rental", "hostel"] as const)
				for (const nights of [1, 2]) {
					out.push(
						cand({
							id: `e1|${tier}|${mode}|${stay}|${nights}`,
							ticket_tier: tier,
							transport_mode: mode,
							lodging_type: stay,
							nights,
							travel_hours: mode === "fly" ? 4.5 : mode === "drive" ? 9 : 11,
							total_minor: tierCost[tier] + modeCost[mode] + stayCost[stay] * nights,
						}),
					);
				}
	out.push(
		cand({
			id: "e2|budget|drive|hotel|1",
			event_id: "e2",
			is_alternative_event: true,
			total_minor: 55000,
		}),
	);
	return out;
};

describe("budgetTotalMinor", () => {
	it("multiplies a per-person budget by the party", () => {
		expect(budgetTotalMinor({ amount_minor: 60000, currency: "CAD", scope: "per_person" }, 2)).toBe(
			120000,
		);
		expect(budgetTotalMinor({ amount_minor: 60000, currency: "CAD", scope: "total" }, 2)).toBe(
			60000,
		);
	});
});

describe("rankPackages", () => {
	it("never returns an over-budget package", () => {
		const r = rankPackages(grid(), request());
		expect(r.packages.length).toBeGreaterThan(0);
		for (const p of r.packages) expect(p.candidate.total_minor).toBeLessThanOrEqual(120000);
	});

	it("keeps a package that costs exactly the budget", () => {
		const r = rankPackages([cand({ total_minor: 120000 })], request());
		expect(r.packages).toHaveLength(1);
	});

	it("applies a per-person budget to the whole party", () => {
		const one = cand({ total_minor: 100000 });
		expect(
			rankPackages(
				[one],
				request({ budget: { amount_minor: 60000, currency: "CAD", scope: "total" } }),
			).packages,
		).toHaveLength(0);
		expect(
			rankPackages(
				[one],
				request({ budget: { amount_minor: 60000, currency: "CAD", scope: "per_person" } }),
			).packages,
		).toHaveLength(1);
	});

	it("returns five distinct labels and five distinct packages on a rich grid", () => {
		const r = rankPackages(grid(), request());
		expect(r.packages.map((p) => p.label)).toEqual([
			"cheapest",
			"best_value",
			"best_experience",
			"weekend",
			"alternative",
		]);
		expect(new Set(r.packages.map((p) => p.candidate.id)).size).toBe(5);
		expect(r.packages.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5]);
	});

	it("puts the lowest total first", () => {
		const r = rankPackages(grid(), request());
		const min = Math.min(
			...grid()
				.filter((c) => !c.is_alternative_event && c.total_minor <= 120000)
				.map((c) => c.total_minor),
		);
		expect(r.packages[0]?.candidate.total_minor).toBe(min);
	});

	it("gives the weekend package more nights than the minimum", () => {
		const r = rankPackages(grid(), request());
		expect(r.packages.find((p) => p.label === "weekend")?.candidate.nights).toBe(2);
	});

	it("makes the alternative a new transport mode or a different event", () => {
		const r = rankPackages(grid(), request());
		const alt = r.packages.find((p) => p.label === "alternative")?.candidate;
		const others = r.packages
			.filter((p) => p.label !== "alternative")
			.map((p) => p.candidate.transport_mode);
		expect(alt && (alt.is_alternative_event || !others.includes(alt.transport_mode))).toBe(true);
	});

	it("returns fewer than five rather than padding with copies, and says what it would take", () => {
		const r = rankPackages(
			grid(),
			request({ budget: { amount_minor: 1000, currency: "CAD", scope: "total" } }),
		);
		expect(r.packages).toHaveLength(0);
		expect(r.cheapest_over_budget_minor).toBe(Math.min(...grid().map((c) => c.total_minor)));
	});

	it("is deterministic regardless of input order", () => {
		const a = rankPackages(grid(), request()).packages.map((p) => p.candidate.id);
		const b = rankPackages([...grid()].reverse(), request()).packages.map((p) => p.candidate.id);
		expect(b).toEqual(a);
	});

	it("refuses to compare candidates in another currency", () => {
		expect(() => rankPackages([cand({ currency: "USD" })], request())).toThrow();
	});
});

describe("score", () => {
	it("is in [0,1] and rewards the preferred transport", () => {
		const prefs = request().prefs;
		const drive = score(cand({ transport_mode: "drive" }), prefs);
		const fly = score(cand({ transport_mode: "fly" }), prefs);
		expect(drive).toBeGreaterThan(fly);
		expect(drive).toBeLessThanOrEqual(1);
		expect(fly).toBeGreaterThanOrEqual(0);
	});

	it("weights live in one place and are all positive", () => {
		for (const w of Object.values(WEIGHTS)) expect(w).toBeGreaterThan(0);
	});
});
