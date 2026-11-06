import { describe, expect, it } from "vitest";
import { buildCandidates } from "./candidates.js";
import { FxTable } from "./money.js";
import type { EventInfo, TripRequest } from "./types.js";

const fx = new FxTable([
	{ base: "USD", quote: "CAD", rate: 1.4, as_of: "2026-11-05" },
	{ base: "USD", quote: "GBP", rate: 0.8, as_of: "2026-11-05" },
]);

const toronto = { label: "Toronto, ON, Canada", lat: 43.6532, lng: -79.3832, country_code: "CA" };
const msg = { lat: 40.7505, lng: -73.9934, country_code: "US", city: "New York" };

const req = (over: Partial<TripRequest> = {}): TripRequest => ({
	origin: toronto,
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

const event = (over: Partial<EventInfo> = {}): EventInfo => ({
	provider: "ticketmaster",
	provider_event_id: "TM1",
	name: "Knicks vs Raptors",
	category: "Sports",
	venue_name: "Madison Square Garden",
	city: "New York",
	country_code: "US",
	lat: msg.lat,
	lng: msg.lng,
	local_date: "2027-03-12",
	starts_at: "2027-03-13T00:30:00Z",
	url: "https://www.ticketmaster.com/event/TM1",
	price_range: { min_minor: 4500, max_minor: 30000, currency: "USD" },
	...over,
});

const build = (r = req(), e = event()) =>
	buildCandidates({
		request: r,
		event: e,
		event_id: "ev1",
		venue: msg,
		is_alternative_event: false,
		fx,
		fetched_at: "2026-11-06T10:00:00Z",
	});

describe("buildCandidates", () => {
	it("offers drive and fly from Toronto to New York, with a passport-relevant international flag", () => {
		const cs = build();
		const modes = new Set(cs.map((c) => c.transport_mode));
		expect(modes.has("drive")).toBe(true);
		expect(modes.has("fly")).toBe(true);
		expect(cs.every((c) => c.international)).toBe(true);
	});

	it("adds border time to a cross-border drive", () => {
		const drive = build().find((c) => c.transport_mode === "drive");
		// ~550 km straight × 1.25 / 85 km/h ≈ 8.1 h + 1 h border
		expect(drive?.travel_hours).toBeGreaterThan(8.5);
	});

	it("includes fees, gas, tolls, parking, lodging taxes and food in a drive package", () => {
		const c = build().find((x) => x.transport_mode === "drive" && x.lodging_type === "hotel");
		const titles = c?.items.map((i) => i.title).join("\n") ?? "";
		for (const t of ["Ticket fees", "Gas", "Tolls", "Parking", "Lodging taxes", "Food allowance"])
			expect(titles).toContain(t);
	});

	it("labels every non-provider number as an estimate with a method", () => {
		for (const c of build())
			for (const i of c.items) {
				if (i.provider === "estimate") {
					expect(i.is_estimate).toBe(true);
					expect(i.method.length).toBeGreaterThan(10);
				}
			}
	});

	it("uses Ticketmaster's listed range as provider prices, not estimates", () => {
		const c = build().find((x) => x.ticket_tier === "budget");
		const ticket = c?.items.find((i) => i.provider === "ticketmaster");
		expect(ticket).toMatchObject({ amount_minor: 9000, currency: "USD", is_estimate: false });
	});

	it("falls back to labelled estimates when no price is listed", () => {
		const cs = build(req(), event({ price_range: null }));
		const t = cs[0]?.items.find((i) => i.kind === "ticket");
		expect(t?.is_estimate).toBe(true);
		expect(t?.title).toContain("no price listed");
	});

	it("totals in the budget currency and rounds each conversion up", () => {
		const c = build()[0];
		expect(c?.currency).toBe("CAD");
		const sum = c?.items.reduce(
			(s, i) =>
				s + fx.convert({ amount_minor: i.amount_minor, currency: i.currency }, "CAD").amount_minor,
			0,
		);
		expect(c?.total_minor).toBe(sum);
	});

	it("respects max_nights", () => {
		expect(
			build(req({ prefs: { ...req().prefs, max_nights: 1 } })).every((c) => c.nights <= 1),
		).toBe(true);
	});

	it("works from another continent: London to New York is fly-only", () => {
		const london = { label: "London, UK", lat: 51.5072, lng: -0.1276, country_code: "GB" };
		const cs = build(
			req({ origin: london, budget: { amount_minor: 300000, currency: "GBP", scope: "total" } }),
		);
		expect(new Set(cs.map((c) => c.transport_mode))).toEqual(new Set(["fly"]));
		expect(cs.every((c) => c.currency === "GBP")).toBe(true);
	});

	it("allows a day trip with no stay when the venue is close", () => {
		const hamilton = { label: "Hamilton, ON", lat: 43.2557, lng: -79.8711, country_code: "CA" };
		const cs = buildCandidates({
			request: req({ origin: hamilton }),
			event: event({ country_code: "CA", city: "Toronto" }),
			event_id: "ev1",
			venue: { lat: 43.6435, lng: -79.3791, country_code: "CA", city: "Toronto" },
			is_alternative_event: false,
			fx,
			fetched_at: "2026-11-06T10:00:00Z",
		});
		expect(cs.some((c) => c.nights === 0 && c.lodging_type === "none")).toBe(true);
	});
});
