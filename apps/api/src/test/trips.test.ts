import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSavedTrips, isAlertWorthy } from "../planning/alerts.js";
import { call, json, mockFetch, postJson, signedInUser } from "./helpers.js";

const mutableEnv = env as unknown as Record<string, string | undefined>;
afterEach(() => {
	vi.restoreAllMocks();
	delete mutableEnv.RESEND_API_KEY;
});

let seq = 0;
const keyword = () => `Leafs trip ${++seq} ${crypto.randomUUID().slice(0, 8)}`;
let day = 0;
/** Future event dates, distinct per test so cached provider answers never leak between tests. */
const nextDate = () => new Date(Date.UTC(2027, 5, 1 + 3 * day++)).toISOString().slice(0, 10);

/** Ticketmaster + FX mocks; `min` is the cheapest face value, so a lower one is a price drop. */
function providers(id: string, date: string, min = 45) {
	const sent: Array<Record<string, unknown>> = [];
	mockFetch(
		(url) =>
			url.hostname === "app.ticketmaster.com"
				? json({
						_embedded: {
							events: [
								{
									id,
									name: "Maple Leafs at Bruins",
									url: `https://www.ticketmaster.com/event/${id}`,
									dates: { start: { localDate: date } },
									classifications: [{ segment: { name: "Sports" } }],
									priceRanges: [{ type: "standard", currency: "USD", min, max: 300 }],
									_embedded: {
										venues: [
											{
												name: "TD Garden",
												city: { name: "Boston" },
												country: { countryCode: "US" },
												location: { latitude: "42.3662", longitude: "-71.0621" },
											},
										],
									},
								},
							],
						},
					})
				: undefined,
		(url) =>
			url.hostname === "api.frankfurter.dev"
				? json({ base: "USD", date: "2026-11-05", rates: { CAD: 1.38 } })
				: undefined,
		(url, init) => {
			if (url.hostname !== "api.resend.com") return undefined;
			sent.push(JSON.parse(String(init?.body)));
			return json({ id: "email_1" });
		},
	);
	return { sent };
}

const request = (query: string, date: string) => ({
	raw_text: "private note: my flat is at 12 Example St",
	origin: { label: "Toronto, ON, Canada", lat: 43.6532, lng: -79.3832, country_code: "CA" },
	event: { query },
	date_from: date,
	date_to: date,
	party_size: 2,
	budget: { amount_minor: 400000, currency: "CAD", scope: "total" },
	prefs: {
		transport: "any",
		stay: "any",
		max_nights: 2,
		seat_quality: "any",
		vibe_tags: [],
		accessibility: "wheelchair access",
	},
});

async function donePlan(cookie: string, body: unknown): Promise<string> {
	const res = await postJson("/plans", body, cookie);
	expect(res.status).toBe(202);
	const { id } = await res.json<{ id: string }>();
	const p = await (await call(`/plans/${id}`, { cookie })).json<{ status: string }>();
	expect(p.status).toBe("done");
	return id;
}

describe("saved trips", () => {
	it("saves, lists, toggles alerts and unsaves — only for the owner", async () => {
		const alice = await signedInUser();
		const bob = await signedInUser();
		const date = nextDate();
		providers("SAVE-1", date);
		const id = await donePlan(alice.cookie, request(keyword(), date));

		expect((await postJson(`/plans/${id}/save`, {}, bob.cookie)).status).toBe(404);
		expect((await postJson(`/plans/${id}/save`, {}, alice.cookie)).status).toBe(200);
		// Saving twice is fine.
		expect((await postJson(`/plans/${id}/save`, {}, alice.cookie)).status).toBe(200);

		const list = await (await call("/trips", { cookie: alice.cookie })).json<any>();
		expect(list.trips).toHaveLength(1);
		expect(list.trips[0]).toMatchObject({ plan_id: id, alerts_enabled: true, currency: "CAD" });
		expect(list.trips[0].best_total_minor).toBeGreaterThan(0);
		expect((await (await call("/trips", { cookie: bob.cookie })).json<any>()).trips).toHaveLength(
			0,
		);

		expect((await postJson(`/plans/${id}/alerts`, { enabled: false }, alice.cookie)).status).toBe(
			200,
		);
		const state = await (await call(`/plans/${id}/saved`, { cookie: alice.cookie })).json<any>();
		expect(state).toMatchObject({ saved: true, alerts_enabled: false });

		expect((await postJson(`/plans/${id}/unsave`, {}, alice.cookie)).status).toBe(200);
		expect((await (await call("/trips", { cookie: alice.cookie })).json<any>()).trips).toHaveLength(
			0,
		);
	});
});

describe("share links", () => {
	it("shows the plan read-only without signing in, minus private details, until revoked", async () => {
		const alice = await signedInUser();
		const bob = await signedInUser();
		const date = nextDate();
		providers("SHARE-1", date);
		const id = await donePlan(alice.cookie, request(keyword(), date));

		expect((await postJson(`/plans/${id}/share`, {}, bob.cookie)).status).toBe(404);
		const made = await postJson(`/plans/${id}/share`, {}, alice.cookie);
		expect(made.status).toBe(201);
		const { share_url } = await made.json<{ share_url: string }>();
		expect(share_url).toMatch(/^https:\/\/tagalong\.averrow\.com\/s\/[A-Za-z0-9_-]{43}$/);
		// Asking again returns the same link.
		expect(
			(await (await postJson(`/plans/${id}/share`, {}, alice.cookie)).json<any>()).share_url,
		).toBe(share_url);

		const token = share_url.split("/s/")[1];
		const res = await call(`/shared/${token}`); // no cookie
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const shared = await res.json<any>();
		expect(shared.shared).toBe(true);
		expect(shared.packages.length).toBeGreaterThan(0);
		const text = JSON.stringify(shared);
		for (const secret of [
			"12 Example St",
			"wheelchair",
			"@example.com",
			"origin_lat",
			"origin_lng",
			"user-",
		]) {
			expect(text).not.toContain(secret);
		}

		expect((await postJson(`/plans/${id}/share/revoke`, {}, alice.cookie)).status).toBe(200);
		expect((await call(`/shared/${token}`)).status).toBe(404);
	});

	it("404s an unknown or malformed token", async () => {
		expect((await call("/shared/not-a-token")).status).toBe(404);
		expect((await call(`/shared/${"A".repeat(43)}`)).status).toBe(404);
	});
});

describe("price-drop alerts", () => {
	it("needs a real drop, not noise", () => {
		expect(isAlertWorthy(100000, 97000)).toBe(true);
		expect(isAlertWorthy(100000, 99500)).toBe(false);
		expect(isAlertWorthy(100000, 100000)).toBe(false);
		expect(isAlertWorthy(null, 50000)).toBe(false);
		expect(isAlertWorthy(100000, null)).toBe(false);
	});

	it("re-checks a saved trip, records the drop and emails the owner", async () => {
		mutableEnv.RESEND_API_KEY = "re_test";
		const u = await signedInUser();
		const date = nextDate();
		providers("ALERT-1", date, 45);
		const id = await donePlan(u.cookie, request(keyword(), date));
		await postJson(`/plans/${id}/save`, {}, u.cookie);
		vi.restoreAllMocks();

		// Ticket face value falls from $45 to $20: every package gets cheaper.
		const { sent } = providers("ALERT-1", date, 20);
		const r = await checkSavedTrips(env);
		expect(r.alerts).toBeGreaterThanOrEqual(1);

		const alert = await env.DB.prepare("SELECT * FROM price_alerts WHERE user_id = ?")
			.bind(u.id)
			.first<any>();
		expect(alert.new_total_minor).toBeLessThan(alert.old_total_minor);
		expect(alert.emailed_at).toBeTruthy();
		const mail = sent.find((m) => (m.to as string[])[0] === `${u.id}@example.com`);
		expect(mail?.subject).toMatch(/^Price drop: Maple Leafs at Bruins now from/);
		expect(String(mail?.html)).toContain(`/plans/${alert.plan_id}`);

		const list = await (await call("/trips", { cookie: u.cookie })).json<any>();
		expect(list.trips[0].plan_id).toBe(alert.plan_id); // follows the newest check
		expect(list.alerts[0]).toMatchObject({ new_total_minor: alert.new_total_minor });

		// Checked just now: the next run skips it.
		vi.restoreAllMocks();
		providers("ALERT-1", date, 10);
		const again = await checkSavedTrips(env);
		const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM price_alerts WHERE user_id = ?")
			.bind(u.id)
			.first<{ n: number }>();
		expect(mine?.n).toBe(1);
		expect(again.checked).toBe(0);
	});

	it("records but does not email without a Resend key, and skips trips with alerts off", async () => {
		const u = await signedInUser();
		const d1 = nextDate();
		const d2 = nextDate();
		providers("ALERT-2", d1, 45);
		const on = await donePlan(u.cookie, request(keyword(), d1));
		await postJson(`/plans/${on}/save`, {}, u.cookie);
		vi.restoreAllMocks();
		providers("ALERT-3", d2, 45);
		const off = await donePlan(u.cookie, request(keyword(), d2));
		await postJson(`/plans/${off}/save`, {}, u.cookie);
		await postJson(`/plans/${off}/alerts`, { enabled: false }, u.cookie);
		vi.restoreAllMocks();

		const m1 = providers("ALERT-2", d1, 20);
		await checkSavedTrips(env, new Date(Date.now() + 13 * 3600 * 1000));
		const alerts = await env.DB.prepare("SELECT * FROM price_alerts WHERE user_id = ?")
			.bind(u.id)
			.all<any>();
		expect(alerts.results).toHaveLength(1);
		expect(alerts.results[0].emailed_at).toBeNull();
		expect(m1.sent).toHaveLength(0);
	});
});
