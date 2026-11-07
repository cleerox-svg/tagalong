import { describe, expect, it } from "vitest";
import { buildCandidates, stayWindow, windowKey } from "./candidates.js";
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

	it("prices an Eventbrite event from its listed range and names the source", () => {
		const e = event({
			provider: "eventbrite",
			provider_event_id: "123456789012",
			url: "https://www.eventbrite.com/e/123456789012",
			price_range: { min_minor: 2500, max_minor: 2500, currency: "USD" },
		});
		const cs = build(req(), e);
		expect(new Set(cs.map((c) => c.ticket_tier))).toEqual(new Set(["budget"]));
		const t = cs[0]?.items.find((i) => i.provider === "eventbrite");
		expect(t).toMatchObject({
			amount_minor: 5000,
			is_estimate: false,
			provider_ref: "123456789012",
		});
		expect(t?.method).toMatch(/^Eventbrite listed face value/);
	});

	it("plans a free event with a zero ticket line and no fee estimate", () => {
		const cs = build(
			req(),
			event({ price_range: { min_minor: 0, max_minor: 0, currency: "USD" } }),
		);
		expect(cs.length).toBeGreaterThan(0);
		for (const c of cs) {
			const tickets = c.items.filter((i) => i.kind === "ticket");
			expect(tickets).toHaveLength(1);
			expect(tickets[0]).toMatchObject({ amount_minor: 0, is_estimate: false });
			expect(tickets[0]?.method).toMatch(/free/);
		}
	});

	it("keeps a free tier at zero next to paid tiers, with fees only on the paid ones", () => {
		const cs = build(
			req(),
			event({ price_range: { min_minor: 0, max_minor: 8000, currency: "USD" } }),
		);
		const budget = cs.find((c) => c.ticket_tier === "budget");
		const premium = cs.find((c) => c.ticket_tier === "premium");
		expect(budget?.items.filter((i) => i.kind === "ticket")).toHaveLength(1);
		expect(premium?.items.filter((i) => i.kind === "ticket")).toHaveLength(2);
	});

	it("says a described (manual) event has no ticket seller and estimates the tickets", () => {
		const cs = build(
			req(),
			event({ provider: "manual", provider_event_id: "m1", url: null, price_range: null }),
		);
		const t = cs[0]?.items.find((i) => i.kind === "ticket");
		expect(t).toMatchObject({ provider: "estimate", is_estimate: true });
		expect(t?.method).toMatch(/no ticket seller/);
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

describe("live prices", () => {
	const liveItem = (
		kind: "transport" | "lodging",
		provider: string,
		amount_minor: number,
	): import("./types.js").CandidateItem => ({
		kind,
		title: `${provider} live`,
		provider,
		provider_ref: "ref",
		amount_minor,
		currency: "USD",
		is_estimate: false,
		booking_url: "https://example.com",
		fetched_at: "2026-11-06T10:00:00Z",
		method: "live",
	});

	it("replaces the fare estimate for the matching window and keeps airport transfers", () => {
		const base = build();
		const fly = base.find(
			(c) => c.transport_mode === "fly" && c.nights === 1 && c.lodging_type === "hotel",
		);
		expect(fly).toBeDefined();
		const key = windowKey({ check_in: fly!.check_in, check_out: fly!.check_out });
		const cs = buildCandidates({
			request: req(),
			event: event(),
			event_id: "ev1",
			venue: msg,
			is_alternative_event: false,
			fx,
			fetched_at: "2026-11-06T10:00:00Z",
			live: { flights: new Map([[key, liveItem("transport", "duffel", 31234)]]) },
		});
		const same = cs.find((c) => c.id === fly!.id)!;
		const transport = same.items.filter((i) => i.kind === "transport");
		expect(transport.map((i) => i.provider)).toEqual(["duffel", "estimate"]);
		expect(transport[1]?.title).toBe("Airport transfers");
		// Other windows keep the estimate.
		const other = cs.find((c) => c.transport_mode === "fly" && c.check_in !== fly!.check_in);
		expect(other?.items.find((i) => i.kind === "transport")?.provider).toBe("estimate");
	});

	it("replaces the hotel estimate and its tax line with one all-in live price, only for hotels", () => {
		const base = build();
		const hotel = base.find((c) => c.lodging_type === "hotel" && c.nights === 1)!;
		const key = windowKey({ check_in: hotel.check_in, check_out: hotel.check_out });
		const cs = buildCandidates({
			request: req(),
			event: event(),
			event_id: "ev1",
			venue: msg,
			is_alternative_event: false,
			fx,
			fetched_at: "2026-11-06T10:00:00Z",
			live: { hotels: new Map([[key, [liveItem("lodging", "booking.com", 20000)]]]) },
		});
		const lodging = cs.find((c) => c.id === hotel.id)!.items.filter((i) => i.kind === "lodging");
		expect(lodging).toHaveLength(1);
		expect(lodging[0]).toMatchObject({ provider: "booking.com", is_estimate: false });
		const hostel = cs.find((c) => c.lodging_type === "hostel" && c.nights === 1)!;
		expect(hostel.items.filter((i) => i.kind === "lodging").every((i) => i.is_estimate)).toBe(true);
	});

	it("puts the event night last in the stay window", () => {
		expect(stayWindow("2027-03-12", 1)).toEqual({
			check_in: "2027-03-12",
			check_out: "2027-03-13",
		});
		expect(stayWindow("2027-03-12", 2)).toEqual({
			check_in: "2027-03-11",
			check_out: "2027-03-13",
		});
		expect(stayWindow("2027-03-12", 0)).toEqual({
			check_in: "2027-03-12",
			check_out: "2027-03-13",
		});
	});
});
