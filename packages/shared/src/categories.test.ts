import { describe, expect, it } from "vitest";
import {
	EVENT_CATEGORIES,
	EVENT_CATEGORY_IDS,
	eventCategory,
	geohash,
	normaliseCategory,
} from "./categories.js";
import { ParsedTripRequestSchema } from "./types.js";

describe("event categories", () => {
	it("has one entry per id, each with exactly one Ticketmaster filter", () => {
		expect(EVENT_CATEGORIES.map((c) => c.id)).toEqual([...EVENT_CATEGORY_IDS]);
		for (const c of EVENT_CATEGORIES) {
			const keys = Object.keys(c.ticketmaster);
			expect(keys).toHaveLength(1);
			expect(["classificationName", "keyword"]).toContain(keys[0]);
		}
	});

	it("looks a category up by id and rejects unknown ids", () => {
		expect(eventCategory("gaming")?.ticketmaster).toEqual({ keyword: "gaming" });
		expect(eventCategory("sports")?.ticketmaster).toEqual({ classificationName: "Sports" });
		expect(eventCategory("raves")).toBeUndefined();
	});

	it("maps provider category names onto the ticket fallback table's names", () => {
		expect(normaliseCategory("Music")).toBe("Music");
		expect(normaliseCategory("Sports & Fitness")).toBe("Sports");
		expect(normaliseCategory("Performing & Visual Arts")).toBe("Arts & Theatre");
		expect(normaliseCategory("Auto, Boat & Air")).toBe("Auto, Boat & Air");
		expect(normaliseCategory("  ")).toBeNull();
		expect(normaliseCategory(null)).toBeNull();
	});

	it("lets the parse step return a category or a link, and defaults both to null", () => {
		const base = {
			origin_text: "Toronto",
			event_query: null,
			event_city: null,
			date_from: "2027-05-01",
			date_to: "2027-05-31",
			party_size: null,
			budget_amount: null,
			budget_currency: null,
			budget_scope: null,
			transport: null,
			stay: null,
			max_nights: null,
			seat_quality: null,
			vibe_tags: [],
			accessibility: null,
		};
		expect(ParsedTripRequestSchema.parse(base)).toMatchObject({
			event_url: null,
			event_category: null,
		});
		expect(
			ParsedTripRequestSchema.parse({ ...base, event_category: "gaming" }).event_category,
		).toBe("gaming");
		expect(ParsedTripRequestSchema.safeParse({ ...base, event_category: "raves" }).success).toBe(
			false,
		);
	});
});

describe("geohash", () => {
	it("matches known hashes", () => {
		// The worked examples from the geohash definition (Wikipedia, geohash.org).
		expect(geohash(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
		expect(geohash(42.6, -5.6, 5)).toBe("ezs42");
	});

	it("defaults to 7 characters", () => {
		expect(geohash(40.7505, -73.9934)).toHaveLength(7);
	});
});
