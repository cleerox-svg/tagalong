/**
 * A ticket price read back from storage keeps the time it was really fetched
 * (spec §2.1: every price is stored and shown with its real `fetched_at`).
 *
 * When an event's page or provider is down on a run, planning falls back to
 * the stored event. Its ticket lines must carry the stored `events.fetched_at`,
 * not the run time, and the run must not refresh `events.fetched_at` either,
 * so repeated outages never make an old price look new. A live read still
 * stamps the run time. Outbound fetch is mocked; nothing reaches the network.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, json, mockFetch, postJson, signedInUser } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const uniq = () => crypto.randomUUID().slice(0, 8);
const OLD = "2026-10-01T08:15:00.000Z";

const page = () =>
	new Response(
		`<!doctype html><html><head><title>Show</title>
		 <script type="application/ld+json">${JSON.stringify({
				"@context": "https://schema.org",
				"@type": "Event",
				name: "Stored Price Show",
				startDate: "2027-05-08T10:00:00-04:00",
				eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
				eventStatus: "https://schema.org/EventScheduled",
				location: {
					"@type": "Place",
					name: "Exhibition Place",
					address: { "@type": "PostalAddress", addressLocality: "Toronto", addressCountry: "CA" },
					geo: { "@type": "GeoCoordinates", latitude: 43.6333, longitude: -79.4186 },
				},
				offers: [
					{ "@type": "Offer", price: "35.00", priceCurrency: "CAD" },
					{ "@type": "Offer", price: 60, priceCurrency: "CAD" },
				],
			})}</script></head><body>hi</body></html>`,
		{ headers: { "Content-Type": "text/html; charset=utf-8" } },
	);

const fx = (url: URL) =>
	url.hostname === "api.frankfurter.dev"
		? json({ amount: 1, base: "USD", date: "2026-11-05", rates: { CAD: 1.38 } })
		: undefined;

const trip = (event: Record<string, unknown>) => ({
	origin: { label: "Montreal, QC, Canada", lat: 45.5019, lng: -73.5674, country_code: "CA" },
	event,
	date_from: "2027-05-01",
	date_to: "2027-05-31",
	party_size: 2,
	budget: { amount_minor: 150000, currency: "CAD", scope: "total" },
	prefs: { transport: "any", stay: "any", max_nights: 2, seat_quality: "any", vibe_tags: [] },
});

interface Ran {
	status: string;
	eventId: string;
	eventFetchedAt: string;
	pricesCheckedAt: string;
	/** fetched_at of every provider (non-estimate-source) ticket line. */
	ticketFetchedAt: string[];
	ticketEstimateFetchedAt: string[];
}

async function inspect(planId: string, provider: string): Promise<Ran> {
	const plan = await env.DB.prepare(
		`SELECT p.status, p.event_id, p.result_json, e.fetched_at AS event_fetched_at
		 FROM plans p JOIN events e ON e.id = p.event_id WHERE p.id = ?`,
	)
		.bind(planId)
		.first<{ status: string; event_id: string; result_json: string; event_fetched_at: string }>();
	expect(plan).not.toBeNull();
	const { results } = await env.DB.prepare(
		`SELECT i.provider, i.fetched_at FROM package_items i JOIN packages k ON k.id = i.package_id
		 WHERE k.plan_id = ? AND i.kind = 'ticket'`,
	)
		.bind(planId)
		.all<{ provider: string; fetched_at: string }>();
	return {
		status: plan!.status,
		eventId: plan!.event_id,
		eventFetchedAt: plan!.event_fetched_at,
		pricesCheckedAt: (JSON.parse(plan!.result_json) as { prices_checked_at: string })
			.prices_checked_at,
		ticketFetchedAt: results.filter((r) => r.provider === provider).map((r) => r.fetched_at),
		ticketEstimateFetchedAt: results
			.filter((r) => r.provider === "estimate")
			.map((r) => r.fetched_at),
	};
}

async function startPlan(cookie: string, body: unknown): Promise<string> {
	const res = await postJson("/plans", body, cookie);
	expect(res.status).toBe(202);
	const { id } = await res.json<{ id: string }>();
	return id;
}

async function recheck(cookie: string, planId: string): Promise<string> {
	const res = await postJson(`/plans/${planId}/recheck`, {}, cookie);
	expect(res.status).toBe(202);
	const { id } = await res.json<{ id: string }>();
	// Let the background run finish (the GET reads its final state).
	await (await call(`/plans/${id}`, { cookie })).json();
	return id;
}

const ageEvent = (eventId: string) =>
	env.DB.prepare("UPDATE events SET fetched_at = ? WHERE id = ?").bind(OLD, eventId).run();

describe("ticket price as-of when the event comes from storage", () => {
	it("a live page read stamps the ticket lines and the event with the run time", async () => {
		const u = await signedInUser();
		const link = `https://stored.example.org/live-${uniq()}`;
		mockFetch((url) => (url.hostname === "stored.example.org" ? page() : undefined), fx);
		const id = await startPlan(
			u.cookie,
			trip({ query: "Show", pinned: { provider: "url", url: link } }),
		);
		const r = await inspect(id, "url");
		expect(r.status).toBe("done");
		expect(r.ticketFetchedAt.length).toBeGreaterThan(0);
		for (const t of r.ticketFetchedAt) expect(t).toBe(r.pricesCheckedAt);
		expect(r.eventFetchedAt).toBe(r.pricesCheckedAt);

		// A later live re-check (page up, an old stored time) refreshes both to that run.
		await ageEvent(r.eventId);
		const again = await inspect(await recheck(u.cookie, id), "url");
		expect(again.status).toBe("done");
		expect(again.pricesCheckedAt).not.toBe(OLD);
		for (const t of again.ticketFetchedAt) expect(t).toBe(again.pricesCheckedAt);
		expect(again.eventFetchedAt).toBe(again.pricesCheckedAt);
	});

	it("page down: ticket lines keep the stored fetched_at, and events.fetched_at is not refreshed", async () => {
		const u = await signedInUser();
		const link = `https://stored.example.org/down-${uniq()}`;
		mockFetch((url) => (url.hostname === "stored.example.org" ? page() : undefined), fx);
		const first = await startPlan(
			u.cookie,
			trip({ query: "Show", pinned: { provider: "url", url: link } }),
		);
		const live = await inspect(first, "url");
		expect(live.status).toBe("done");
		await ageEvent(live.eventId);
		vi.restoreAllMocks();

		mockFetch((url) => (url.hostname === "stored.example.org" ? json({}, 503) : undefined), fx);
		// Re-check skips the page cache, so the run really sees the 503.
		const down = await inspect(await recheck(u.cookie, first), "url");
		expect(down.status).toBe("done");
		expect(down.eventId).toBe(live.eventId);
		expect(down.pricesCheckedAt).not.toBe(OLD);
		expect(down.ticketFetchedAt.length).toBeGreaterThan(0);
		for (const t of down.ticketFetchedAt) expect(t).toBe(OLD);
		expect(down.eventFetchedAt).toBe(OLD);
		// Fee estimates are unaffected: they keep the estimate table's own date.
		for (const t of down.ticketEstimateFetchedAt) expect(t).not.toBe(down.pricesCheckedAt);

		// A second outage still keeps the original time.
		const again = await inspect(await recheck(u.cookie, first), "url");
		expect(again.status).toBe("done");
		for (const t of again.ticketFetchedAt) expect(t).toBe(OLD);
		expect(again.eventFetchedAt).toBe(OLD);
	});

	it("Eventbrite API and page down: the stored event's time is kept the same way", async () => {
		const u = await signedInUser();
		const ebId = `8${Date.now()}`.slice(0, 12);
		mockFetch(
			(url) =>
				url.hostname === "www.eventbriteapi.com"
					? json({
							id: ebId,
							name: { text: "Stored Expo" },
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
							is_free: false,
							ticket_availability: {
								minimum_ticket_price: { major_value: "25.00", currency: "CAD" },
								maximum_ticket_price: { major_value: "40.00", currency: "CAD" },
							},
						})
					: undefined,
			(url) => (url.hostname === "www.eventbrite.com" ? page() : undefined),
			fx,
		);
		const first = await startPlan(
			u.cookie,
			trip({ query: "Expo", pinned: { provider: "eventbrite", id: ebId } }),
		);
		const live = await inspect(first, "eventbrite");
		expect(live.status).toBe("done");
		expect(live.ticketFetchedAt.length).toBeGreaterThan(0);
		for (const t of live.ticketFetchedAt) expect(t).toBe(live.pricesCheckedAt);
		await ageEvent(live.eventId);
		vi.restoreAllMocks();

		mockFetch(
			(url) =>
				url.hostname === "www.eventbriteapi.com" || url.hostname === "www.eventbrite.com"
					? json({}, 503)
					: undefined,
			fx,
		);
		const down = await inspect(await recheck(u.cookie, first), "eventbrite");
		expect(down.status).toBe("done");
		expect(down.ticketFetchedAt.length).toBeGreaterThan(0);
		for (const t of down.ticketFetchedAt) expect(t).toBe(OLD);
		expect(down.eventFetchedAt).toBe(OLD);
	});
});
