import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, json, mockFetch, postJson, signedInUser } from "./helpers.js";

const mutableEnv = env as unknown as Record<string, string | undefined>;

beforeEach(() => {
	mutableEnv.DUFFEL_ACCESS_TOKEN = "duffel_test_token";
	mutableEnv.BOOKING_API_TOKEN = "booking-test-token";
	mutableEnv.BOOKING_AFFILIATE_ID = "123456";
});
afterEach(() => {
	vi.restoreAllMocks();
	delete mutableEnv.DUFFEL_ACCESS_TOKEN;
	delete mutableEnv.BOOKING_API_TOKEN;
	delete mutableEnv.BOOKING_AFFILIATE_ID;
});

let seq = 0;
const keyword = () => `Raptors live ${++seq} ${crypto.randomUUID().slice(0, 8)}`;
/** A different event date per test: cached provider answers are keyed by dates and place. */
let day = 0;
const nextDate = () => {
	const d = new Date(Date.UTC(2027, 3, 1 + 7 * day++));
	return d.toISOString().slice(0, 10);
};

const tmEvent = (id: string, date: string) => ({
	id,
	name: "Toronto Raptors at New York Knicks",
	url: `https://www.ticketmaster.com/event/${id}`,
	dates: { start: { localDate: date } },
	classifications: [{ segment: { name: "Sports" } }],
	priceRanges: [{ type: "standard", currency: "USD", min: 45, max: 300 }],
	_embedded: {
		venues: [
			{
				name: "Madison Square Garden",
				city: { name: "New York" },
				country: { countryCode: "US" },
				location: { latitude: "40.7505", longitude: "-73.9934" },
			},
		],
	},
});

interface Opts {
	duffelStatus?: number;
	fare?: string;
	hotelTotal?: number | null;
}

/** Ticketmaster, FX, Duffel and Booking.com, all mocked. Counts provider calls. */
function providers(id: string, date: string, o: Opts = {}) {
	const counts = { offers: 0, stays: 0 };
	const m = mockFetch(
		(url) =>
			url.hostname === "app.ticketmaster.com"
				? json({ _embedded: { events: [tmEvent(id, date)] } })
				: undefined,
		(url) =>
			url.hostname === "api.frankfurter.dev"
				? json({ base: "USD", date: "2026-11-05", rates: { CAD: 1.38 } })
				: undefined,
		(url, init) => {
			if (url.hostname !== "api.duffel.com") return undefined;
			const h = new Headers(init?.headers);
			expect(h.get("Authorization")).toBe("Bearer duffel_test_token");
			expect(h.get("Duffel-Version")).toBe("v2");
			if (o.duffelStatus) return json({ errors: [] }, o.duffelStatus);
			if (url.pathname === "/places/suggestions") {
				const lat = Number(url.searchParams.get("lat"));
				return json({
					data: [
						{
							type: "airport",
							iata_code: lat > 42 ? "YYZ" : "JFK",
							iata_city_code: lat > 42 ? "YTO" : "NYC",
						},
					],
				});
			}
			counts.offers++;
			const body = JSON.parse(String(init?.body));
			expect(body.data.passengers).toHaveLength(2);
			expect(body.data.slices[0]).toMatchObject({ origin: "YTO", destination: "NYC" });
			return json({
				data: {
					offers: [
						{
							id: "off_2",
							total_amount: "999.00",
							total_currency: "USD",
							owner: { name: "Pricey Air" },
							slices: [],
						},
						{
							id: "off_1",
							total_amount: o.fare ?? "250.00",
							total_currency: "USD",
							expires_at: "2026-11-06T12:00:00Z",
							owner: { name: "Duffel Airways" },
							slices: [{ segments: [{}] }, { segments: [{}, {}] }],
						},
					],
				},
			});
		},
		(url, init) => {
			if (url.hostname !== "demandapi.booking.com") return undefined;
			const h = new Headers(init?.headers);
			expect(h.get("X-Affiliate-Id")).toBe("123456");
			const body = JSON.parse(String(init?.body));
			if (url.pathname.endsWith("/accommodations/search")) {
				counts.stays++;
				expect(body.coordinates).toMatchObject({
					latitude: 40.7505,
					longitude: -73.9934,
					radius: 5,
				});
				expect(body.currency).toBe("CAD");
				expect(body.booker.country).toBe("ca");
				if (o.hotelTotal === null) return json({ data: [] });
				return json({
					data: [
						{
							id: 7,
							currency: "CAD",
							price: { book: 400, total: 440 },
							url: "https://www.booking.com/hotel/us/other.html",
						},
						{
							id: 9,
							currency: "CAD",
							price: { book: 280, total: o.hotelTotal ?? 310.5 },
							url: "https://www.booking.com/hotel/us/test.html",
						},
					],
				});
			}
			return json({ data: [{ id: 9, name: { "en-gb": "Hotel Test Midtown" } }] });
		},
	);
	return { ...m, counts };
}

const request = (query: string, date: string) => ({
	origin: { label: "Toronto, ON, Canada", lat: 43.6532, lng: -79.3832, country_code: "CA" },
	event: { query },
	date_from: date,
	date_to: date,
	party_size: 2,
	budget: { amount_minor: 300000, currency: "CAD", scope: "total" },
	prefs: { transport: "any", stay: "hotel", max_nights: 2, seat_quality: "any", vibe_tags: [] },
});

async function plan(cookie: string, body: unknown) {
	const res = await postJson("/plans", body, cookie);
	expect(res.status).toBe(202);
	const { id } = await res.json<{ id: string }>();
	return (await call(`/plans/${id}`, { cookie })).json<any>();
}

const allItems = (p: any) => p.packages.flatMap((k: any) => k.items);

describe("live prices", () => {
	it("uses Duffel's cheapest fare and Booking.com's cheapest stay instead of estimates", async () => {
		const u = await signedInUser();
		const date = nextDate();
		providers("LIVE-1", date);
		const p = await plan(u.cookie, request(keyword(), date));
		expect(p.status).toBe("done");
		expect(p.result.live).toEqual({ flights: "live", hotels: "live" });

		const items = allItems(p);
		const flight = items.find((i: any) => i.provider === "duffel");
		const stay = items.find((i: any) => i.provider === "booking.com");
		if (flight) {
			expect(flight).toMatchObject({ amount_minor: 25000, currency: "USD", is_estimate: false });
			expect(flight.title).toContain("Duffel Airways");
			expect(flight.title).toContain("direct out, 1 stop back");
		}
		expect(stay).toMatchObject({ amount_minor: 31050, currency: "CAD", is_estimate: false });
		expect(stay.title).toContain("Hotel Test Midtown");
		expect(stay.booking_url).toBe("https://www.booking.com/hotel/us/test.html");
		// In a package with a live all-in hotel price there is no separate tax estimate.
		const liveHotel = p.packages.filter((k: any) =>
			k.items.some((i: any) => i.provider === "booking.com"),
		);
		expect(liveHotel.length).toBeGreaterThan(0);
		for (const k of liveHotel) {
			expect(k.items.some((i: any) => i.title === "Lodging taxes (estimated)")).toBe(false);
		}
		for (const k of p.packages) expect(k.total_minor).toBeLessThanOrEqual(300000);
	});

	it("falls back to labelled estimates when Duffel errors, and says so", async () => {
		const u = await signedInUser();
		const date = nextDate();
		providers("LIVE-2", date, { duffelStatus: 500 });
		const p = await plan(u.cookie, request(keyword(), date));
		expect(p.status).toBe("done");
		expect(p.result.live.flights).toBe("unavailable");
		expect(allItems(p).some((i: any) => i.provider === "duffel")).toBe(false);
	});

	it("reports no_offers when Booking.com has nothing for the dates", async () => {
		const u = await signedInUser();
		const date = nextDate();
		providers("LIVE-3", date, { hotelTotal: null });
		const p = await plan(u.cookie, request(keyword(), date));
		expect(p.result.live.hotels).toBe("no_offers");
		expect(allItems(p).some((i: any) => i.provider === "booking.com")).toBe(false);
	});

	it("reports not_configured and keeps working without keys", async () => {
		delete mutableEnv.DUFFEL_ACCESS_TOKEN;
		delete mutableEnv.BOOKING_API_TOKEN;
		const u = await signedInUser();
		const date = nextDate();
		providers("LIVE-4", date);
		const p = await plan(u.cookie, request(keyword(), date));
		expect(p.status).toBe("done");
		expect(p.result.live).toEqual({ flights: "not_configured", hotels: "not_configured" });
	});
});

describe("POST /plans/:id/recheck", () => {
	it("re-runs with fresh provider calls and shows the previous totals", async () => {
		const u = await signedInUser();
		const q = keyword();
		const date = nextDate();
		const first = providers("LIVE-5", date);
		const p1 = await plan(u.cookie, request(q, date));
		expect(first.counts.stays).toBeGreaterThan(0);
		const offersBefore = first.counts.offers;
		const staysBefore = first.counts.stays;
		vi.restoreAllMocks();

		const second = providers("LIVE-5", date, { hotelTotal: 290 });
		const res = await postJson(`/plans/${p1.id}/recheck`, {}, u.cookie);
		expect(res.status).toBe(202);
		const { id } = await res.json<{ id: string }>();
		expect(id).not.toBe(p1.id);
		const p2 = await (await call(`/plans/${id}`, { cookie: u.cookie })).json<any>();

		expect(p2.status).toBe("done");
		// Fresh: the cache was bypassed, so the providers were asked again.
		expect(second.counts.stays).toBe(staysBefore);
		expect(second.counts.offers).toBe(offersBefore);
		expect(p2.rechecked_from).toBe(p1.id);
		expect(p2.previous.id).toBe(p1.id);
		expect(p2.previous.packages.map((k: any) => k.label)).toEqual(
			p1.packages.map((k: any) => k.label),
		);
		const stay = allItems(p2).find((i: any) => i.provider === "booking.com");
		expect(stay.amount_minor).toBe(29000);
	});

	it("another user cannot re-check my plan", async () => {
		const alice = await signedInUser();
		const bob = await signedInUser();
		const date = nextDate();
		providers("LIVE-6", date);
		const p = await plan(alice.cookie, request(keyword(), date));
		const res = await postJson(`/plans/${p.id}/recheck`, {}, bob.cookie);
		expect(res.status).toBe(404);
	});
});
