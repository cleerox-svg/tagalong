import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEventPage, priceToMinor } from "../providers/event-page.js";
import { eventbriteIdFromUrl, mapEventbrite } from "../providers/eventbrite.js";
import { ticketmasterIdFromUrl } from "../providers/ticketmaster.js";
import { call, json, mockFetch, postJson, signedInUser } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

/** Unique per test so the provider cache never serves another test's page. */
const uniq = () => crypto.randomUUID().slice(0, 8);

const html = (ld: unknown, title = "Event page") =>
	new Response(
		`<!doctype html><html><head><title>${title}</title>
		 <meta property="og:title" content="${title}">
		 <script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>hi</body></html>`,
		{ headers: { "Content-Type": "text/html; charset=utf-8" } },
	);

const carShow = (over: Record<string, unknown> = {}) => ({
	"@context": "https://schema.org",
	"@type": "Event",
	name: "Tuner Evolution &amp; Import Show",
	startDate: "2027-05-08T10:00:00-04:00",
	eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
	eventStatus: "https://schema.org/EventScheduled",
	location: {
		"@type": "Place",
		name: "Exhibition Place",
		address: {
			"@type": "PostalAddress",
			addressLocality: "Toronto",
			addressCountry: "CA",
		},
		geo: { "@type": "GeoCoordinates", latitude: 43.6333, longitude: -79.4186 },
	},
	offers: [
		{
			"@type": "Offer",
			price: "35.00",
			priceCurrency: "CAD",
			url: "https://tickets.example.org/t",
		},
		{ "@type": "Offer", price: 60, priceCurrency: "CAD" },
	],
	...over,
});

const fx = (url: URL) =>
	url.hostname === "api.frankfurter.dev"
		? json({ amount: 1, base: "USD", date: "2026-11-05", rates: { CAD: 1.38 } })
		: undefined;

const places = (url: URL) =>
	url.hostname === "places.googleapis.com"
		? json({
				places: [
					{
						formattedAddress: "Ottawa, ON, Canada",
						location: { latitude: 45.4215, longitude: -75.6972 },
						addressComponents: [{ shortText: "CA", types: ["country", "political"] }],
					},
				],
			})
		: undefined;

const montreal = { label: "Montreal, QC, Canada", lat: 45.5019, lng: -73.5674, country_code: "CA" };

const trip = (event: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
	origin: montreal,
	event,
	date_from: "2027-05-01",
	date_to: "2027-05-31",
	party_size: 2,
	budget: { amount_minor: 150000, currency: "CAD", scope: "total" },
	prefs: { transport: "any", stay: "any", max_nights: 2, seat_quality: "any", vibe_tags: [] },
	...over,
});

async function planFor(cookie: string, body: unknown) {
	const res = await postJson("/plans", body, cookie);
	expect(res.status).toBe(202);
	const { id } = await res.json<{ id: string }>();
	return (await call(`/plans/${id}`, { cookie })).json<any>();
}

describe("event page parsing", () => {
	it("reads name, date, venue, city, country, coordinates and the listed price range", () => {
		const r = parseEventPage(
			`<script type="application/ld+json">${JSON.stringify(carShow())}</script>`,
			"https://example.org/show",
			"id1",
		);
		expect(r.online).toBe(false);
		expect(r.event).toMatchObject({
			provider: "url",
			provider_event_id: "id1",
			name: "Tuner Evolution & Import Show",
			venue_name: "Exhibition Place",
			city: "Toronto",
			country_code: "CA",
			lat: 43.6333,
			local_date: "2027-05-08",
			starts_at: "2027-05-08T14:00:00.000Z",
			url: "https://example.org/show",
			price_range: { min_minor: 3500, max_minor: 6000, currency: "CAD" },
		});
	});

	it("finds an Event inside @graph, and ignores prices with no currency or a bad amount", () => {
		const ld = {
			"@graph": [
				{ "@type": "WebPage", name: "x" },
				{
					...carShow(),
					"@type": ["MusicEvent"],
					offers: [
						{ price: "20" },
						{ price: "12.345", priceCurrency: "USD" },
						{ "@type": "AggregateOffer", lowPrice: "15", highPrice: "45.50", priceCurrency: "USD" },
					],
				},
			],
		};
		const r = parseEventPage(
			`<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
			"https://example.org/x",
			"id2",
		);
		expect(r.event?.category).toBe("Music");
		expect(r.event?.price_range).toEqual({ min_minor: 1500, max_minor: 4550, currency: "USD" });
	});

	it("flags online-only and cancelled events, and returns the page title when there is no Event", () => {
		const online = parseEventPage(
			`<script type="application/ld+json">${JSON.stringify(
				carShow({
					eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
					location: { "@type": "VirtualLocation", url: "https://zoom.us/j/1" },
				}),
			)}</script>`,
			"https://example.org/o",
			"id3",
		);
		expect(online.online).toBe(true);
		const cancelled = parseEventPage(
			`<script type="application/ld+json">${JSON.stringify(
				carShow({ eventStatus: "https://schema.org/EventCancelled" }),
			)}</script>`,
			"https://example.org/c",
			"id4",
		);
		expect(cancelled.cancelled).toBe(true);
		const none = parseEventPage(
			'<html><head><meta property="og:title" content="Fall Meet &amp; Greet"></head></html>',
			"https://www.facebook.com/events/1",
			"id5",
		);
		expect(none).toEqual({
			event: null,
			online: false,
			cancelled: false,
			title: "Fall Meet & Greet",
		});
	});

	it("turns schema.org prices into minor units without floats", () => {
		expect(priceToMinor("35.00", "CAD")).toBe(3500);
		expect(priceToMinor(60, "CAD")).toBe(6000);
		expect(priceToMinor("$1,200.50", "USD")).toBe(120050);
		expect(priceToMinor("Free", "USD")).toBe(0);
		expect(priceToMinor("1500", "JPY")).toBe(1500);
		expect(priceToMinor("12.345", "USD")).toBeNull();
		expect(priceToMinor(-5, "USD")).toBeNull();
		expect(priceToMinor({}, "USD")).toBeNull();
	});

	it("recognises Eventbrite and Ticketmaster event links", () => {
		expect(
			eventbriteIdFromUrl(new URL("https://www.eventbrite.ca/e/tuner-show-tickets-812345678901")),
		).toBe("812345678901");
		expect(eventbriteIdFromUrl(new URL("https://www.eventbrite.com/e/812345678901/"))).toBe(
			"812345678901",
		);
		expect(eventbriteIdFromUrl(new URL("https://eventbrite.evil.example/e/812345678901"))).toBe(
			null,
		);
		expect(
			ticketmasterIdFromUrl(
				new URL("https://www.ticketmaster.ca/raptors-vs-knicks/event/10006123ABCD1234"),
			),
		).toBe("10006123ABCD1234");
		expect(ticketmasterIdFromUrl(new URL("https://example.org/event/10006123ABCD1234"))).toBe(null);
	});

	it("maps an Eventbrite API event, using the listed major values", () => {
		const r = mapEventbrite({
			id: "812345678901",
			name: { text: "Ottawa Gaming Expo" },
			url: "https://www.eventbrite.ca/e/812345678901",
			start: { local: "2027-05-15T10:00:00", utc: "2027-05-15T14:00:00Z" },
			category: { name: "Science & Technology" },
			venue: {
				name: "Shaw Centre",
				address: { city: "Ottawa", country: "CA", latitude: "45.4256", longitude: "-75.6919" },
			},
			ticket_availability: {
				minimum_ticket_price: { currency: "CAD", major_value: "25.00" },
				maximum_ticket_price: { currency: "CAD", major_value: "80.00" },
			},
		});
		expect(r.event).toMatchObject({
			provider: "eventbrite",
			city: "Ottawa",
			country_code: "CA",
			lat: 45.4256,
			local_date: "2027-05-15",
			price_range: { min_minor: 2500, max_minor: 8000, currency: "CAD" },
		});
		const free = mapEventbrite({
			id: "1234567",
			name: { text: "Meetup" },
			currency: "CAD",
			is_free: true,
			start: { local: "2027-05-15T10:00:00" },
		});
		expect(free.event?.price_range).toEqual({ min_minor: 0, max_minor: 0, currency: "CAD" });
	});
});

describe("POST /events/lookup", () => {
	it("reads a pasted page, pins it, and remembers what it said", async () => {
		const u = await signedInUser();
		const link = `https://shows.example.org/tuner-${uniq()}?utm_source=x#tickets`;
		const { calls } = mockFetch((url) =>
			url.hostname === "shows.example.org" ? html(carShow()) : undefined,
		);
		const res = await postJson("/events/lookup", { url: link }, u.cookie);
		expect(res.status).toBe(200);
		const { event } = await res.json<any>();
		expect(event.pinned).toEqual({ provider: "url", url: link.replace(/\?.*$/, "") });
		expect(event).toMatchObject({
			name: "Tuner Evolution & Import Show",
			city: "Toronto",
			local_date: "2027-05-08",
			price_range: { min_minor: 3500, max_minor: 6000, currency: "CAD" },
		});
		expect(calls).toHaveLength(1);
		const row = await env.DB.prepare(
			"SELECT name, price_min_minor, price_currency FROM events WHERE provider = 'url' AND url = ?",
		)
			.bind(event.pinned.url)
			.all();
		expect(row.results).toContainEqual({
			name: "Tuner Evolution & Import Show",
			price_min_minor: 3500,
			price_currency: "CAD",
		});
	});

	it("uses the Eventbrite API for an Eventbrite link and sends the token only there", async () => {
		const u = await signedInUser();
		const id = `8${Date.now()}`.slice(0, 12);
		const { calls } = mockFetch((url, init) => {
			if (url.hostname !== "www.eventbriteapi.com") return undefined;
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				`Bearer ${env.EVENTBRITE_TOKEN}`,
			);
			expect(url.pathname).toBe(`/v3/events/${id}/`);
			return json({
				id,
				name: { text: "Ottawa Gaming Expo" },
				url: `https://www.eventbrite.ca/e/${id}`,
				start: { local: "2027-05-15T10:00:00", utc: "2027-05-15T14:00:00Z" },
				venue: { name: "Shaw Centre", address: { city: "Ottawa", country: "CA" } },
				ticket_availability: {
					minimum_ticket_price: { currency: "CAD", major_value: "25.00" },
					maximum_ticket_price: { currency: "CAD", major_value: "25.00" },
				},
			});
		});
		const res = await postJson(
			"/events/lookup",
			{ url: `https://www.eventbrite.ca/e/ottawa-gaming-expo-tickets-${id}` },
			u.cookie,
		);
		expect(res.status).toBe(200);
		const { event } = await res.json<any>();
		expect(event.pinned).toEqual({ provider: "eventbrite", id });
		expect(event.price_range).toEqual({ min_minor: 2500, max_minor: 2500, currency: "CAD" });
		for (const url of calls) expect(url.hostname).toBe("www.eventbriteapi.com");
	});

	it("falls back to reading the Eventbrite page when the API fails", async () => {
		const u = await signedInUser();
		const id = `7${Date.now()}`.slice(0, 12);
		mockFetch(
			(url) => (url.hostname === "www.eventbriteapi.com" ? json({}, 500) : undefined),
			(url) =>
				url.hostname === "www.eventbrite.com"
					? html(carShow({ name: "Page fallback" }))
					: undefined,
		);
		const res = await postJson(
			"/events/lookup",
			{ url: `https://www.eventbrite.com/e/${id}` },
			u.cookie,
		);
		expect(res.status).toBe(200);
		const { event } = await res.json<any>();
		expect(event).toMatchObject({ name: "Page fallback", provider: "eventbrite" });
		expect(event.pinned).toEqual({ provider: "eventbrite", id });
	});

	it("says why a page can't be planned: unreadable (with its title), online, past", async () => {
		const u = await signedInUser();
		const tag = uniq();
		mockFetch((url) => {
			if (url.hostname === "www.facebook.com")
				return new Response('<meta property="og:title" content="Fall Car Meet">', {
					headers: { "Content-Type": "text/html" },
				});
			if (url.pathname === `/online-${tag}`)
				return html(carShow({ eventAttendanceMode: "OnlineEventAttendanceMode", location: [] }));
			if (url.pathname === `/past-${tag}`) return html(carShow({ startDate: "2020-01-01" }));
			return undefined;
		});
		const fb = await postJson(
			"/events/lookup",
			{ url: `https://www.facebook.com/events/${tag}` },
			u.cookie,
		);
		expect(fb.status).toBe(422);
		expect((await fb.json<any>()).error).toMatchObject({
			code: "unreadable",
			details: { title: "Fall Car Meet" },
		});
		const online = await postJson(
			"/events/lookup",
			{ url: `https://example.org/online-${tag}` },
			u.cookie,
		);
		expect((await online.json<any>()).error.code).toBe("online");
		const past = await postJson(
			"/events/lookup",
			{ url: `https://example.org/past-${tag}` },
			u.cookie,
		);
		expect((await past.json<any>()).error.code).toBe("past");
	});

	it("never fetches internal, IP-literal or our own addresses", async () => {
		const u = await signedInUser();
		const { calls } = mockFetch();
		for (const url of [
			"http://127.0.0.1/admin",
			"http://localhost:8787/plans",
			"http://[::1]/",
			"http://169.254.169.254/latest/meta-data/",
			"http://2130706433/",
			"https://metadata.google.internal/computeMetadata/v1/",
			"https://tagalong-api.averrow.com/me",
			"https://user:pass@example.org/e",
			"https://example.org:8443/e",
			"ftp://example.org/e",
		]) {
			const res = await postJson("/events/lookup", { url }, u.cookie);
			expect(res.status, url).toBe(422);
			expect((await res.json<any>()).error.code, url).toBe("blocked");
		}
		expect(calls).toHaveLength(0);
	});

	it("re-checks every redirect and refuses one that points inside", async () => {
		const u = await signedInUser();
		const tag = uniq();
		const { calls } = mockFetch((url) =>
			url.hostname === "short.example.org"
				? new Response(null, {
						status: 302,
						headers: { Location: "http://169.254.169.254/latest/meta-data/" },
					})
				: undefined,
		);
		const res = await postJson(
			"/events/lookup",
			{ url: `https://short.example.org/${tag}` },
			u.cookie,
		);
		expect(res.status).toBe(422);
		expect((await res.json<any>()).error.code).toBe("blocked");
		expect(calls.map((c) => c.hostname)).toEqual(["short.example.org"]);
	});

	it("requires sign-in and the 18+ confirmation", async () => {
		expect((await postJson("/events/lookup", { url: "https://example.org/e" })).status).toBe(401);
		const minor = await signedInUser({ adult: false });
		expect(
			(await postJson("/events/lookup", { url: "https://example.org/e" }, minor.cookie)).status,
		).toBe(403);
	});
});

describe("planning any event", () => {
	it("plans a pasted page, pricing tickets from the page and re-reading it on the run", async () => {
		const u = await signedInUser();
		const link = `https://shows.example.org/tuner-${uniq()}`;
		const { calls } = mockFetch(
			(url) => (url.hostname === "shows.example.org" ? html(carShow()) : undefined),
			fx,
		);
		const plan = await planFor(
			u.cookie,
			trip({ query: "Tuner Evolution", pinned: { provider: "url", url: link } }),
		);
		expect(plan.status).toBe("done");
		expect(plan.event_name).toBe("Tuner Evolution & Import Show");
		expect(plan.packages.length).toBeGreaterThan(0);
		for (const p of plan.packages) expect(p.total_minor).toBeLessThanOrEqual(150000);
		const ticket = plan.packages[0].items.find((i: any) => i.provider === "url");
		expect(ticket).toMatchObject({ currency: "CAD", is_estimate: false });
		expect(ticket.method).toContain("shows.example.org");
		expect(calls.some((c) => c.hostname === "shows.example.org")).toBe(true);
		expect(plan.result.other_events).toEqual([]);
	});

	it("plans from what the link said when the page is down at run time", async () => {
		const u = await signedInUser();
		const link = `https://flaky.example.org/show-${uniq()}`;
		mockFetch((url) => (url.hostname === "flaky.example.org" ? html(carShow()) : undefined));
		expect((await postJson("/events/lookup", { url: link }, u.cookie)).status).toBe(200);
		vi.restoreAllMocks();

		mockFetch((url) => (url.hostname === "flaky.example.org" ? json({}, 503) : undefined), fx);
		const res = await postJson(
			"/plans",
			trip({ query: "Tuner", pinned: { provider: "url", url: link } }),
			u.cookie,
		);
		const { id } = await res.json<{ id: string }>();
		// Re-check skips the page cache, so the run really sees the 503.
		const recheck = await postJson(`/plans/${id}/recheck`, {}, u.cookie);
		const { id: rid } = await recheck.json<{ id: string }>();
		const plan = await (await call(`/plans/${rid}`, { cookie: u.cookie })).json<any>();
		expect(plan.status).toBe("done");
		expect(plan.event_name).toBe("Tuner Evolution & Import Show");
	});

	it("plans an Eventbrite event by id", async () => {
		const u = await signedInUser();
		const id = `9${Date.now()}`.slice(0, 12);
		mockFetch(
			(url) =>
				url.hostname === "www.eventbriteapi.com"
					? json({
							id,
							name: { text: "Ottawa Gaming Expo" },
							start: { local: "2027-05-15T10:00:00" },
							venue: {
								name: "Shaw Centre",
								address: {
									city: "Ottawa",
									country: "CA",
									latitude: "45.4256",
									longitude: "-75.6919",
								},
							},
							is_free: true,
							currency: "CAD",
						})
					: undefined,
			fx,
		);
		const plan = await planFor(
			u.cookie,
			trip({ query: "Gaming Expo", pinned: { provider: "eventbrite", id } }),
		);
		expect(plan.status).toBe("done");
		const ticket = plan.packages[0].items.find((i: any) => i.kind === "ticket");
		expect(ticket).toMatchObject({ provider: "eventbrite", amount_minor: 0, is_estimate: false });
	});

	it("plans an event the user described, geocoding its city and estimating tickets", async () => {
		const u = await signedInUser();
		mockFetch(places, fx);
		const plan = await planFor(
			u.cookie,
			trip(
				{ query: `Fall Car Meet ${uniq()}`, city: "Ottawa", manual: true },
				{ date_from: "2027-05-08", date_to: "2027-05-08" },
			),
		);
		expect(plan.status).toBe("done");
		expect(plan.event_city).toBe("Ottawa");
		const ticket = plan.packages[0].items.find((i: any) => i.kind === "ticket");
		expect(ticket).toMatchObject({ provider: "estimate", is_estimate: true });
		expect(ticket.method).toMatch(/no ticket seller/);
	});

	it("refuses a pinned link to an internal address before planning", async () => {
		const u = await signedInUser();
		const res = await postJson(
			"/plans",
			trip({ query: "x", pinned: { provider: "url", url: "http://169.254.169.254/" } }),
			u.cookie,
		);
		expect(res.status).toBe(400);
		expect((await res.json<any>()).error.code).toBe("blocked");
	});

	it("fails with a readable message when a pinned page has become an online event", async () => {
		const u = await signedInUser();
		const link = `https://shows.example.org/moved-${uniq()}`;
		mockFetch(
			(url) =>
				url.hostname === "shows.example.org"
					? html(carShow({ eventAttendanceMode: "OnlineEventAttendanceMode", location: [] }))
					: undefined,
			fx,
		);
		const plan = await planFor(
			u.cookie,
			trip({ query: "x", pinned: { provider: "url", url: link } }),
		);
		expect(plan.status).toBe("failed");
		expect(plan.error).toMatch(/online event/);
	});
});

describe("GET /events/browse", () => {
	const tmEvent = (id: string) => ({
		id,
		name: "Gaming Expo Toronto",
		url: `https://www.ticketmaster.ca/event/${id}`,
		dates: { start: { localDate: "2027-05-20" } },
		classifications: [{ segment: { name: "Miscellaneous" } }],
		_embedded: {
			venues: [
				{
					name: "Enercare Centre",
					city: { name: "Toronto" },
					country: { countryCode: "CA" },
					location: { latitude: "43.6335", longitude: "-79.4163" },
				},
			],
		},
	});

	const q = (over: Record<string, string> = {}) =>
		new URLSearchParams({
			category: "gaming",
			lat: "43.6532",
			lng: "-79.3832",
			radius_km: "100",
			date_from: "2027-05-01",
			date_to: "2027-05-31",
			...over,
		});

	it("searches Ticketmaster near a city by category and returns pinnable events", async () => {
		const u = await signedInUser();
		const { calls } = mockFetch((url) =>
			url.hostname === "app.ticketmaster.com"
				? json({ _embedded: { events: [tmEvent(`G-${uniq()}`)] } })
				: undefined,
		);
		const res = await call(`/events/browse?${q({ date_to: "2027-05-30" })}`, { cookie: u.cookie });
		expect(res.status).toBe(200);
		const { events } = await res.json<any>();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			name: "Gaming Expo Toronto",
			city: "Toronto",
			local_date: "2027-05-20",
			pinned: { provider: "ticketmaster" },
		});
		const sent = calls[0]?.searchParams;
		expect(sent?.get("keyword")).toBe("gaming");
		expect(sent?.get("geoPoint")).toMatch(/^dpz8[0-9a-z]{3}$/);
		expect(sent?.get("radius")).toBe("100");
		expect(sent?.get("unit")).toBe("km");
		expect(sent?.get("classificationName")).toBeNull();
	});

	it("uses Ticketmaster's classification for categories that have one", async () => {
		const u = await signedInUser();
		const { calls } = mockFetch((url) =>
			url.hostname === "app.ticketmaster.com" ? json({}) : undefined,
		);
		const res = await call(`/events/browse?${q({ category: "sports", date_to: "2027-05-29" })}`, {
			cookie: u.cookie,
		});
		expect(res.status).toBe(200);
		expect((await res.json<any>()).events).toEqual([]);
		expect(calls[0]?.searchParams.get("classificationName")).toBe("Sports");
	});

	it("rejects unknown categories, odd radii and over-long windows, and needs sign-in", async () => {
		const u = await signedInUser();
		mockFetch();
		for (const bad of [
			{ category: "raves" },
			{ radius_km: "7" },
			{ date_from: "2027-05-01", date_to: "2028-12-31" },
			{ date_from: "2027-05-31", date_to: "2027-05-01" },
		]) {
			expect((await call(`/events/browse?${q(bad)}`, { cookie: u.cookie })).status).toBe(400);
		}
		expect((await call(`/events/browse?${q()}`)).status).toBe(401);
	});
});
