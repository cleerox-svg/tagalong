/**
 * JarvisReadApi (docs/SETUP.md §1j): the read-only RPC entrypoint Jarvis
 * reaches through a service binding. The class is constructed directly with
 * an execution context and an env (the shape the runtime gives it), so the
 * allowlist secret and a broken DB can be supplied per test. Every row is
 * seeded with prepared statements against the real /migrations schema.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { JarvisReadApi as ExportedFromIndex } from "../index.js";
import { JarvisReadApi } from "../jarvis-read-api.js";
import { upcomingCutoff } from "../lib/jarvis-read.js";

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	// Guards the wrapper itself: if it stopped running, conformance would pass vacuously.
	expect(conformanceChecks).toBeGreaterThan(40);
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A verbatim copy of Jarvis's Tagalong contract (jarvis
 * apps/api/src/lib/connections/contract.ts, `TagalongTripsSchema`, zod 4).
 * Jarvis drops the whole answer if it fails this, so every successful
 * getUpcomingTrips result in this file is parsed against it (see `api`).
 */
const label = (max: number) => z.string().trim().min(1).max(max);
const TagalongTripsSchema = z.object({
	trips: z
		.array(
			z.object({
				title: label(120),
				date: z.iso.date(),
				city: label(80).nullable(),
				cheapest: z
					.object({
						amountMinor: z.number().int().min(0).max(10_000_000_000),
						currency: z.string().regex(/^[A-Z]{3}$/),
						isEstimate: z.boolean(),
						asOf: z.iso.datetime({ offset: true }),
					})
					.nullable(),
			}),
		)
		.max(20),
});

/** How many results the wrapper in `api` has checked against Jarvis's schema. */
let conformanceChecks = 0;

function api(allowlist?: string, overrides: Partial<Env> = {}): JarvisReadApi {
	const e = { ...env, ...overrides } as Env;
	if (allowlist === undefined) delete (e as { JARVIS_READ_EMAILS?: string }).JARVIS_READ_EMAILS;
	else e.JARVIS_READ_EMAILS = allowlist;
	const a = new JarvisReadApi(createExecutionContext(), e);
	// Every successful answer must be one Jarvis accepts; rejections pass through.
	const read = a.getUpcomingTrips.bind(a);
	a.getUpcomingTrips = async (email: unknown) => {
		const res = await read(email);
		const parsed = TagalongTripsSchema.safeParse(res);
		if (!parsed.success) {
			throw new Error(`not Jarvis-conformant: ${parsed.error.message}\n${JSON.stringify(res)}`);
		}
		conformanceChecks++;
		return res;
	};
	return a;
}

const uid = () => crypto.randomUUID();

/** A unique address per test, so tests never see each other's rows. */
const freshEmail = (tag = "u") => `${tag}-${uid()}@example.com`;

/** UTC date `days` from today, YYYY-MM-DD. */
function day(days: number): string {
	return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function seedUser(
	email: string,
	opts: { googleSub?: string; deletedAt?: string | null } = {},
): Promise<string> {
	const id = `jr-user-${uid()}`;
	await env.DB.prepare(
		`INSERT INTO users (id, google_sub, email, display_name, birthdate_verified_18, home_currency, deleted_at)
		 VALUES (?, ?, ?, 'Jarvis Test', 1, 'CAD', ?)`,
	)
		.bind(
			id,
			opts.googleSub ?? `1${Math.floor(Math.random() * 1e15)}`,
			email,
			opts.deletedAt ?? null,
		)
		.run();
	return id;
}

async function seedEvent(e: {
	name: string;
	city?: string | null;
	localDate?: string | null;
}): Promise<string> {
	const id = `jr-evt-${uid()}`;
	await env.DB.prepare(
		`INSERT INTO events (id, provider, provider_event_id, name, city, country, local_date, fetched_at)
		 VALUES (?, 'manual', ?, ?, ?, 'CA', ?, '2026-01-01T00:00:00Z')`,
	)
		.bind(id, id, e.name, e.city ?? null, e.localDate ?? null)
		.run();
	return id;
}

interface ItemSeed {
	isEstimate?: boolean;
	fetchedAt?: string;
}
interface PackageSeed {
	rank: number;
	total: number;
	currency?: string;
	items?: ItemSeed[];
}

async function seedPlan(
	userId: string,
	tripId: string,
	opts: {
		eventId?: string | null;
		status?: string;
		packages?: PackageSeed[];
		resultJson?: string;
	} = {},
): Promise<string> {
	const planId = `jr-plan-${uid()}`;
	await env.DB.prepare(
		`INSERT INTO plans (id, user_id, trip_request_id, event_id, status, result_json)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			planId,
			userId,
			tripId,
			opts.eventId ?? null,
			opts.status ?? "done",
			opts.resultJson ?? "{}",
		)
		.run();
	const labels = ["cheapest", "best_value", "best_experience", "weekend", "alternative"];
	for (const pk of opts.packages ?? []) {
		const pkgEvent = await seedEvent({ name: "Package event" });
		const pkgId = `jr-pkg-${uid()}`;
		await env.DB.prepare(
			`INSERT INTO packages (id, plan_id, rank, label, event_id, total_minor, currency, score, summary_text, details_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'summary', '{}')`,
		)
			.bind(
				pkgId,
				planId,
				pk.rank,
				labels[(pk.rank - 1) % labels.length],
				pkgEvent,
				pk.total,
				pk.currency ?? "CAD",
			)
			.run();
		let pos = 0;
		for (const it of pk.items ?? [{}]) {
			await env.DB.prepare(
				`INSERT INTO package_items (id, package_id, position, kind, title, provider, amount_minor, currency,
				   is_estimate, booking_url, fetched_at, method)
				 VALUES (?, ?, ?, 'ticket', 'Item', 'ticketmaster', 100, ?, ?, 'https://book.example/x', ?, 'live')`,
			)
				.bind(
					`jr-item-${uid()}`,
					pkgId,
					pos++,
					pk.currency ?? "CAD",
					it.isEstimate ? 1 : 0,
					it.fetchedAt ?? "2026-11-01T10:00:00.000Z",
				)
				.run();
		}
	}
	return planId;
}

interface TripSeed {
	eventQuery?: string;
	dateFrom?: string;
	eventCity?: string | null;
	/** An event attached to the latest plan; omitted → no event. */
	event?: { name: string; city?: string | null; localDate?: string | null };
	status?: string;
	saved?: boolean;
	bestTotal?: number | null;
	packages?: PackageSeed[];
	/** Packages of an OLDER plan (saved_trips.plan_id), which must be ignored. */
	oldPlanPackages?: PackageSeed[];
	createdAt?: string;
	/** plans.result_json of the latest plan; omitted → '{}'. */
	resultJson?: string;
}

async function seedTrip(
	userId: string,
	t: TripSeed = {},
): Promise<{ tripId: string; planId: string }> {
	const tripId = `jr-trip-${uid()}`;
	await env.DB.prepare(
		`INSERT INTO trip_requests (id, user_id, raw_text, origin_city, origin_lat, origin_lng, origin_country,
		   event_query, event_city, date_from, date_to, party_size, budget_minor, budget_currency, budget_scope, prefs_json)
		 VALUES (?, ?, 'SECRET RAW TEXT', 'Ottawa', 45.42, -75.69, 'CA', ?, ?, ?, ?, 2, 99999, 'CAD', 'total', '{}')`,
	)
		.bind(
			tripId,
			userId,
			t.eventQuery ?? "Leafs game",
			t.eventCity === undefined ? "Toronto" : t.eventCity,
			t.dateFrom ?? day(10),
			t.dateFrom ?? day(11),
		)
		.run();
	const eventId = t.event ? await seedEvent(t.event) : null;
	const oldPlan = t.oldPlanPackages
		? await seedPlan(userId, tripId, { eventId, packages: t.oldPlanPackages })
		: null;
	const planId = await seedPlan(userId, tripId, {
		eventId,
		...(t.status !== undefined ? { status: t.status } : {}),
		...(t.resultJson !== undefined ? { resultJson: t.resultJson } : {}),
		packages: t.packages ?? [],
	});
	if (t.saved !== false) {
		await env.DB.prepare(
			`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, best_total_minor, currency, created_at)
			 VALUES (?, ?, ?, ?, ?, 'CAD', ?)`,
		)
			.bind(
				userId,
				oldPlan ?? planId,
				tripId,
				planId,
				t.bestTotal === undefined ? null : t.bestTotal,
				t.createdAt ?? new Date().toISOString(),
			)
			.run();
	}
	return { tripId, planId };
}

/** A real, allowlisted user with one simple upcoming saved trip. */
async function allowedUserWithTrip(): Promise<{ email: string; id: string }> {
	const email = freshEmail();
	const id = await seedUser(email);
	await seedTrip(id, { eventQuery: "Simple trip" });
	return { email, id };
}

// ---------------------------------------------------------------------------
// 1. Class surface
// ---------------------------------------------------------------------------

describe("JarvisReadApi surface", () => {
	it("is the class index.ts exports", () => {
		expect(ExportedFromIndex).toBe(JarvisReadApi);
	});

	it("has exactly ping and getUpcomingTrips as own methods, and no fetch", () => {
		const own = Object.getOwnPropertyNames(JarvisReadApi.prototype)
			.filter((n) => n !== "constructor")
			.sort();
		expect(own).toEqual(["getUpcomingTrips", "ping"]);
		const instance = api("") as unknown as Record<string, unknown>;
		expect(instance.fetch).toBeUndefined();
		expect("fetch" in JarvisReadApi.prototype).toBe(false);
	});

	it("ping answers the app name and contract version 1", () => {
		expect(api().ping()).toEqual({ app: "tagalong", contractVersion: 1 });
	});
});

// ---------------------------------------------------------------------------
// 2. Allowlist (JARVIS_READ_EMAILS)
// ---------------------------------------------------------------------------

describe("allowlist", () => {
	it("unset → no trips, even for a real user with saved trips", async () => {
		const { email } = await allowedUserWithTrip();
		expect(await api(undefined).getUpcomingTrips(email)).toEqual({ trips: [] });
	});

	it("empty or separator-only → no trips", async () => {
		const { email } = await allowedUserWithTrip();
		expect(await api("").getUpcomingTrips(email)).toEqual({ trips: [] });
		expect(await api(" , ;  ").getUpcomingTrips(email)).toEqual({ trips: [] });
	});

	it("an address not on the list → no trips", async () => {
		const { email } = await allowedUserWithTrip();
		const res = await api(`other@example.com,${email}x`).getUpcomingTrips(email);
		expect(res).toEqual({ trips: [] });
	});

	it("matches case-insensitively and ignores surrounding spaces, on both sides", async () => {
		const { email } = await allowedUserWithTrip();
		const res = await api(`  ${email.toUpperCase()}  `).getUpcomingTrips(
			`  ${email.toUpperCase()} `,
		);
		expect(res.trips).toHaveLength(1);
		expect(res.trips[0]!.title).toBe("Simple trip");
	});

	it.each([
		["comma", ","],
		["space", " "],
		["semicolon", ";"],
		["mixed", " ;, \n"],
	])("accepts %s separators", async (_n, sep) => {
		const { email } = await allowedUserWithTrip();
		const list = ["a@example.com", email, "b@example.com"].join(sep);
		expect((await api(list).getUpcomingTrips(email)).trips).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 3. Identity
// ---------------------------------------------------------------------------

describe("identity", () => {
	it("an allowlisted address with no account → no trips", async () => {
		const email = freshEmail("nobody");
		expect(await api(email).getUpcomingTrips(email)).toEqual({ trips: [] });
	});

	it("a deleted account (sentinel sub + deleted_at) → no trips", async () => {
		const email = freshEmail("deleted");
		const id = await seedUser(email, {
			googleSub: `deleted:${uid()}`,
			deletedAt: "2026-11-01T00:00:00Z",
		});
		await seedTrip(id);
		expect(await api(email).getUpcomingTrips(email)).toEqual({ trips: [] });
	});

	it("deleted_at alone (real google sub) → no trips", async () => {
		const email = freshEmail("deleted2");
		const id = await seedUser(email, { deletedAt: "2026-11-01T00:00:00Z" });
		await seedTrip(id);
		expect(await api(email).getUpcomingTrips(email)).toEqual({ trips: [] });
	});

	it("an Apple-only account (apple: sentinel sub) → no trips", async () => {
		const email = freshEmail("apple");
		const id = await seedUser(email, { googleSub: `apple:${uid()}` });
		await seedTrip(id);
		expect(await api(email).getUpcomingTrips(email)).toEqual({ trips: [] });
	});

	it("two live accounts sharing the address case-insensitively → no trips", async () => {
		const email = freshEmail("dup");
		const a = await seedUser(email);
		const b = await seedUser(` ${email.toUpperCase()} `);
		await seedTrip(a);
		await seedTrip(b);
		expect(await api(email).getUpcomingTrips(email)).toEqual({ trips: [] });
	});

	it("a deleted duplicate does not block the one live account", async () => {
		const email = freshEmail("dup-deleted");
		const live = await seedUser(email);
		await seedUser(email, { googleSub: `deleted:${uid()}`, deletedAt: "2026-11-01T00:00:00Z" });
		await seedTrip(live, { eventQuery: "Live one" });
		const res = await api(email).getUpcomingTrips(email);
		expect(res.trips.map((t) => t.title)).toEqual(["Live one"]);
	});

	it("matches a stored address that has different case and padding", async () => {
		const email = freshEmail("stored");
		const id = await seedUser(`  ${email.toUpperCase()}  `);
		await seedTrip(id, { eventQuery: "Padded" });
		expect((await api(email).getUpcomingTrips(email)).trips).toHaveLength(1);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["number", 42],
		["object", { email: "x@example.com" }],
		["array", ["x@example.com"]],
		["empty string", ""],
		["whitespace", "   "],
	])("non-string or empty input (%s) → no trips", async (_n, input) => {
		expect(await api("x@example.com").getUpcomingTrips(input)).toEqual({ trips: [] });
	});

	it("an oversized address (>320 chars) → no trips, even when allowlisted", async () => {
		const long = `${"a".repeat(310)}@example.com`;
		const id = await seedUser(long);
		await seedTrip(id);
		expect(long.length).toBeGreaterThan(320);
		expect(await api(long).getUpcomingTrips(long)).toEqual({ trips: [] });
	});
});

// ---------------------------------------------------------------------------
// 4. Scoping
// ---------------------------------------------------------------------------

describe("scoping", () => {
	it("returns only the caller's saved trips, never another user's", async () => {
		const mine = freshEmail("mine");
		const theirs = freshEmail("theirs");
		const me = await seedUser(mine);
		const them = await seedUser(theirs);
		await seedTrip(me, { eventQuery: "My trip" });
		await seedTrip(them, { eventQuery: "Their trip" });
		const res = await api(`${mine},${theirs}`).getUpcomingTrips(mine);
		expect(res.trips.map((t) => t.title)).toEqual(["My trip"]);
	});

	it("a saved row pointing at another user's plan is not returned", async () => {
		const mine = freshEmail("mine2");
		const me = await seedUser(mine);
		const them = await seedUser(freshEmail("them2"));
		const { tripId, planId } = await seedTrip(them, { eventQuery: "Stolen", saved: false });
		await env.DB.prepare(
			`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, currency)
			 VALUES (?, ?, ?, ?, 'CAD')`,
		)
			.bind(me, planId, tripId, planId)
			.run();
		expect(await api(mine).getUpcomingTrips(mine)).toEqual({ trips: [] });
	});

	it("planned-but-not-saved trips are not returned", async () => {
		const email = freshEmail("unsaved");
		const id = await seedUser(email);
		await seedTrip(id, { eventQuery: "Only planned", saved: false });
		await seedTrip(id, { eventQuery: "Saved one" });
		const res = await api(email).getUpcomingTrips(email);
		expect(res.trips.map((t) => t.title)).toEqual(["Saved one"]);
	});

	it("returns only the contract fields (no raw text, budget, origin, links)", async () => {
		const email = freshEmail("shape");
		const id = await seedUser(email);
		await seedTrip(id, {
			eventQuery: "Shape",
			packages: [{ rank: 1, total: 5000 }],
		});
		const res = await api(email).getUpcomingTrips(email);
		expect(Object.keys(res)).toEqual(["trips"]);
		expect(Object.keys(res.trips[0]!).sort()).toEqual(["cheapest", "city", "date", "title"]);
		expect(Object.keys(res.trips[0]!.cheapest!).sort()).toEqual([
			"amountMinor",
			"asOf",
			"currency",
			"isEstimate",
		]);
		const text = JSON.stringify(res);
		for (const leak of ["SECRET RAW TEXT", "Ottawa", "99999", "book.example", id]) {
			expect(text).not.toContain(leak);
		}
	});
});

// ---------------------------------------------------------------------------
// 5. Upcoming filter, order, cap, title/city
// ---------------------------------------------------------------------------

describe("upcoming filter and order", () => {
	it("keeps yesterday (UTC) and later, drops anything older", async () => {
		const email = freshEmail("dates");
		const id = await seedUser(email);
		const cutoff = upcomingCutoff();
		expect(cutoff).toBe(day(-1));
		await seedTrip(id, { eventQuery: "Two days ago", dateFrom: day(-2) });
		await seedTrip(id, { eventQuery: "Last year", dateFrom: day(-400) });
		await seedTrip(id, { eventQuery: "Yesterday", dateFrom: day(-1) });
		await seedTrip(id, { eventQuery: "Today", dateFrom: day(0) });
		// The event's own date wins over date_from, both ways.
		await seedTrip(id, {
			eventQuery: "q",
			dateFrom: day(30),
			event: { name: "Event was last week", localDate: day(-7) },
		});
		await seedTrip(id, {
			eventQuery: "q",
			dateFrom: day(-30),
			event: { name: "Event is next week", localDate: day(7) },
		});
		const res = await api(email).getUpcomingTrips(email);
		expect(res.trips.map((t) => [t.title, t.date])).toEqual([
			["Yesterday", day(-1)],
			["Today", day(0)],
			["Event is next week", day(7)],
		]);
	});

	it("orders ascending by event date, else date_from", async () => {
		const email = freshEmail("order");
		const id = await seedUser(email);
		await seedTrip(id, { eventQuery: "C", dateFrom: day(30) });
		await seedTrip(id, {
			eventQuery: "q",
			dateFrom: day(1),
			event: { name: "B", localDate: day(20) },
		});
		await seedTrip(id, { eventQuery: "A", dateFrom: day(5) });
		await seedTrip(id, {
			eventQuery: "q",
			dateFrom: day(40),
			event: { name: "D", localDate: null },
		});
		const res = await api(email).getUpcomingTrips(email);
		expect(res.trips.map((t) => t.title)).toEqual(["A", "B", "C", "D"]);
		expect(res.trips.map((t) => t.date)).toEqual([day(5), day(20), day(30), day(40)]);
	});

	it("caps at 20 trips, soonest first", async () => {
		const email = freshEmail("cap");
		const id = await seedUser(email);
		for (let i = 0; i < 23; i++) {
			await seedTrip(id, {
				eventQuery: `Trip ${String(i).padStart(2, "0")}`,
				dateFrom: day(i + 1),
			});
		}
		const res = await api(email).getUpcomingTrips(email);
		expect(res.trips).toHaveLength(20);
		expect(res.trips[0]!.title).toBe("Trip 00");
		expect(res.trips[19]!.title).toBe("Trip 19");
	});

	it("still returns 20 when earlier rows are skipped (untitled or bad date)", async () => {
		const email = freshEmail("skip");
		const id = await seedUser(email);
		// Untitled: blank event name and blank query.
		for (let i = 0; i < 3; i++) {
			await seedTrip(id, {
				eventQuery: "   ",
				dateFrom: day(1),
				event: { name: "  ", localDate: day(1) },
			});
		}
		// Not a real date (Feb 30) sorts as a string but must be skipped.
		await seedTrip(id, { eventQuery: "Bad date", dateFrom: "2099-02-30" });
		await seedTrip(id, { eventQuery: "Not ISO", dateFrom: "9999-99-99" });
		for (let i = 0; i < 22; i++) {
			await seedTrip(id, {
				eventQuery: `Good ${String(i).padStart(2, "0")}`,
				dateFrom: day(i + 2),
			});
		}
		const res = await api(email).getUpcomingTrips(email);
		expect(res.trips).toHaveLength(20);
		expect(res.trips.every((t) => t.title.startsWith("Good"))).toBe(true);
		expect(res.trips[0]!.title).toBe("Good 00");
		for (const t of res.trips) expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("title is the event name, falling back to the event query when the name is blank or absent", async () => {
		const email = freshEmail("title");
		const id = await seedUser(email);
		await seedTrip(id, {
			eventQuery: "query 1",
			dateFrom: day(1),
			event: { name: " Event Name ", localDate: day(1) },
		});
		await seedTrip(id, {
			eventQuery: " query 2 ",
			dateFrom: day(2),
			event: { name: "   ", localDate: day(2) },
		});
		await seedTrip(id, { eventQuery: "query 3", dateFrom: day(3) });
		const res = await api(email).getUpcomingTrips(email);
		expect(res.trips.map((t) => t.title)).toEqual(["Event Name", "query 2", "query 3"]);
	});

	it("clips title to 120 and city to 80 without splitting a surrogate pair", async () => {
		const email = freshEmail("clip");
		const id = await seedUser(email);
		await seedTrip(id, {
			eventQuery: "x".repeat(200),
			dateFrom: day(1),
			eventCity: "c".repeat(100),
		});
		// 119 units + a 2-unit emoji: the emoji does not fit and is dropped whole.
		await seedTrip(id, {
			eventQuery: `${"a".repeat(119)}😀tail`,
			dateFrom: day(2),
			eventCity: `${"b".repeat(79)}😀`,
		});
		// Exactly at the limits survives untouched; trailing space after a cut is trimmed.
		await seedTrip(id, {
			eventQuery: `${"t".repeat(119)} xyz`,
			dateFrom: day(3),
			eventCity: "e".repeat(80),
		});
		const res = await api(email).getUpcomingTrips(email);
		const [a, b, c] = res.trips;
		expect(a!.title).toBe("x".repeat(120));
		expect(a!.city).toBe("c".repeat(80));
		expect(b!.title).toBe("a".repeat(119));
		expect(b!.city).toBe("b".repeat(79));
		expect(c!.title).toBe("t".repeat(119));
		expect(c!.city).toBe("e".repeat(80));
		for (const t of res.trips) {
			expect(t.title.length).toBeGreaterThanOrEqual(1);
			expect(t.title.length).toBeLessThanOrEqual(120);
			expect(t.city!.length).toBeLessThanOrEqual(80);
			expect(t.title).not.toMatch(/[\uD800-\uDBFF]$/);
		}
	});

	it("city prefers the event's city, falls back to the trip's, and blank → null", async () => {
		const email = freshEmail("city");
		const id = await seedUser(email);
		await seedTrip(id, {
			eventQuery: "q1",
			dateFrom: day(1),
			eventCity: "Trip City",
			event: { name: "One", city: "Event City", localDate: day(1) },
		});
		await seedTrip(id, {
			eventQuery: "q2",
			dateFrom: day(2),
			eventCity: "Trip City",
			event: { name: "Two", city: null, localDate: day(2) },
		});
		await seedTrip(id, { eventQuery: "Three", dateFrom: day(3), eventCity: null });
		await seedTrip(id, { eventQuery: "Four", dateFrom: day(4), eventCity: "   " });
		const res = await api(email).getUpcomingTrips(email);
		expect(res.trips.map((t) => t.city)).toEqual(["Event City", "Trip City", null, null]);
	});
});

// ---------------------------------------------------------------------------
// 6. Price integrity
// ---------------------------------------------------------------------------

async function cheapestOf(t: TripSeed) {
	const email = freshEmail("price");
	const id = await seedUser(email);
	await seedTrip(id, { eventQuery: "Priced", ...t });
	const res = await api(email).getUpcomingTrips(email);
	expect(res.trips).toHaveLength(1);
	return res.trips[0]!.cheapest;
}

describe("cheapest price", () => {
	it("is the latest plan's lowest package total, not saved_trips.best_total_minor or an older plan", async () => {
		const c = await cheapestOf({
			bestTotal: 1,
			oldPlanPackages: [{ rank: 1, total: 2 }],
			packages: [
				{ rank: 1, total: 90_000 },
				{ rank: 2, total: 45_678, items: [{ fetchedAt: "2026-11-05T08:00:00.000Z" }] },
				{ rank: 3, total: 120_000 },
			],
		});
		expect(c).toEqual({
			amountMinor: 45_678,
			currency: "CAD",
			isEstimate: false,
			asOf: "2026-11-05T08:00:00.000Z",
		});
	});

	it("breaks a tie on total by rank", async () => {
		const c = await cheapestOf({
			packages: [
				{ rank: 2, total: 5000, currency: "EUR", items: [{ isEstimate: true }] },
				{ rank: 1, total: 5000, currency: "EUR", items: [{ isEstimate: false }] },
			],
		});
		expect(c).toMatchObject({ amountMinor: 5000, currency: "EUR", isEstimate: false });
	});

	it("returns the package's own currency, unconverted (JPY, KWD)", async () => {
		expect(
			await cheapestOf({ packages: [{ rank: 1, total: 12345, currency: "JPY" }] }),
		).toMatchObject({
			amountMinor: 12345,
			currency: "JPY",
		});
		expect(
			await cheapestOf({ packages: [{ rank: 1, total: 1234, currency: "KWD" }] }),
		).toMatchObject({
			amountMinor: 1234,
			currency: "KWD",
		});
	});

	it("isEstimate is true iff any item in that package is an estimate", async () => {
		const mixed = await cheapestOf({
			packages: [{ rank: 1, total: 100, items: [{ isEstimate: false }, { isEstimate: true }, {}] }],
		});
		expect(mixed!.isEstimate).toBe(true);
		const live = await cheapestOf({
			packages: [
				{ rank: 1, total: 100, items: [{}, {}] },
				// A dearer package's estimate must not leak into the cheapest one.
				{ rank: 2, total: 200, items: [{ isEstimate: true }] },
			],
		});
		expect(live!.isEstimate).toBe(false);
	});

	it("asOf is the oldest item's fetched_at, as ISO", async () => {
		const c = await cheapestOf({
			packages: [
				{
					rank: 1,
					total: 100,
					items: [
						{ fetchedAt: "2026-11-10T12:00:00Z" },
						{ fetchedAt: "2026-11-03T06:30:00Z" },
						{ fetchedAt: "2026-11-08T00:00:00.000Z" },
					],
				},
			],
		});
		expect(c!.asOf).toBe("2026-11-03T06:30:00.000Z");
	});

	it("amount 0 is a valid price", async () => {
		expect(await cheapestOf({ packages: [{ rank: 1, total: 0 }] })).toMatchObject({
			amountMinor: 0,
		});
	});

	it("amount exactly at the 10,000,000,000 ceiling is kept", async () => {
		expect(await cheapestOf({ packages: [{ rank: 1, total: 10_000_000_000 }] })).toMatchObject({
			amountMinor: 10_000_000_000,
		});
	});

	it.each(["queued", "running", "failed"])("null when the latest plan is %s", async (status) => {
		expect(await cheapestOf({ status, packages: [{ rank: 1, total: 100 }] })).toBeNull();
	});

	it("null when the plan has no packages", async () => {
		expect(await cheapestOf({ packages: [], bestTotal: 5000 })).toBeNull();
	});

	it("null when the cheapest package has no items", async () => {
		expect(
			await cheapestOf({
				packages: [
					{ rank: 1, total: 100, items: [] },
					{ rank: 2, total: 200 },
				],
			}),
		).toBeNull();
	});

	it("null when any item's fetched_at is unparseable", async () => {
		expect(
			await cheapestOf({
				packages: [{ rank: 1, total: 100, items: [{}, { fetchedAt: "not a date" }] }],
			}),
		).toBeNull();
	});

	it.each([
		["negative", -1, "CAD"],
		["over the ceiling", 10_000_000_001, "CAD"],
		["fractional", 12.5, "CAD"],
		["lowercase currency", 100, "cad"],
		["short currency", 100, "CA"],
		["long currency", 100, "CADD"],
		["empty currency", 100, ""],
	])("null for an out-of-contract stored value (%s)", async (_n, total, currency) => {
		expect(await cheapestOf({ packages: [{ rank: 1, total, currency }] })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 6b. One currency per comparison, and asOf covers the FX rate date
// ---------------------------------------------------------------------------

/** plans.result_json exactly as planning/run.ts writes it, with the given fx entries. */
function planResult(fx: { from: string; to?: string; rate?: number; as_of: unknown }[]): string {
	return JSON.stringify({
		considered: 12,
		within_budget: 3,
		budget_total_minor: 99_999,
		currency: "CAD",
		cheapest_over_budget_minor: null,
		fx: fx.map((f) => ({ from: f.from, to: f.to ?? "CAD", rate: f.rate ?? 1.37, as_of: f.as_of })),
		// Older than everything below: must never be taken for the price's date.
		estimates: { version: 1, as_of: "2020-01-01T00:00:00Z" },
		live: { flights: "ok", hotels: "ok" },
		prices_checked_at: "2026-11-09T00:00:00.000Z",
		other_events: [],
	});
}

const ITEMS = [
	{ fetchedAt: "2026-11-08T09:00:00.000Z" },
	{ fetchedAt: "2026-11-06T15:30:00.000Z" },
];

describe("cheapest: currencies", () => {
	it("null when the plan's packages are in more than one currency", async () => {
		expect(
			await cheapestOf({
				packages: [
					{ rank: 1, total: 50_000, currency: "CAD" },
					{ rank: 2, total: 60_000, currency: "USD" },
				],
			}),
		).toBeNull();
	});

	it("null even when the numerically cheaper total is in another currency", async () => {
		// 9,000 JPY is "smaller" than 50,000 CAD as a bare integer; never compared.
		expect(
			await cheapestOf({
				packages: [
					{ rank: 1, total: 50_000, currency: "CAD" },
					{ rank: 2, total: 9_000, currency: "JPY" },
				],
			}),
		).toBeNull();
	});

	it("null when only a dearer package carries the second currency", async () => {
		expect(
			await cheapestOf({
				packages: [
					{ rank: 1, total: 100, currency: "EUR" },
					{ rank: 2, total: 200, currency: "EUR" },
					{ rank: 3, total: 300, currency: "GBP" },
				],
			}),
		).toBeNull();
	});

	it("an older plan in another currency does not affect the latest plan", async () => {
		expect(
			await cheapestOf({
				oldPlanPackages: [{ rank: 1, total: 1, currency: "USD" }],
				packages: [{ rank: 1, total: 700, currency: "CAD" }],
			}),
		).toMatchObject({ amountMinor: 700, currency: "CAD" });
	});

	it("single currency still returns the lowest, tie broken by rank", async () => {
		const c = await cheapestOf({
			packages: [
				{ rank: 3, total: 8_000, currency: "USD", items: [{ isEstimate: true }] },
				{ rank: 2, total: 4_000, currency: "USD", items: [{ isEstimate: true }] },
				{ rank: 1, total: 4_000, currency: "USD", items: [{ isEstimate: false }] },
			],
		});
		expect(c).toMatchObject({ amountMinor: 4_000, currency: "USD", isEstimate: false });
	});
});

describe("cheapest: asOf with FX", () => {
	it("is the FX as_of (midnight UTC) when older than every item's fetched_at", async () => {
		const c = await cheapestOf({
			resultJson: planResult([{ from: "USD", as_of: "2026-11-04" }]),
			packages: [{ rank: 1, total: 5_000, items: ITEMS }],
		});
		expect(c).toEqual({
			amountMinor: 5_000,
			currency: "CAD",
			isEstimate: false,
			asOf: "2026-11-04T00:00:00.000Z",
		});
	});

	it("is the oldest item's fetched_at when the FX date is newer", async () => {
		const c = await cheapestOf({
			resultJson: planResult([{ from: "USD", as_of: "2026-11-07" }]),
			packages: [{ rank: 1, total: 5_000, items: ITEMS }],
		});
		expect(c!.asOf).toBe("2026-11-06T15:30:00.000Z");
	});

	it("an FX date on the same day as, but before, the oldest item wins", async () => {
		const c = await cheapestOf({
			resultJson: planResult([{ from: "USD", as_of: "2026-11-06" }]),
			packages: [{ rank: 1, total: 5_000, items: ITEMS }],
		});
		expect(c!.asOf).toBe("2026-11-06T00:00:00.000Z");
	});

	it("with several fx entries, takes the oldest", async () => {
		const c = await cheapestOf({
			resultJson: planResult([
				{ from: "USD", as_of: "2026-11-05" },
				{ from: "GBP", as_of: "2026-11-02", rate: 1.8 },
				{ from: "EUR", as_of: "2026-11-03", rate: 1.5 },
			]),
			packages: [{ rank: 1, total: 5_000, items: ITEMS }],
		});
		expect(c!.asOf).toBe("2026-11-02T00:00:00.000Z");
	});

	it("an empty fx list uses item times only", async () => {
		const c = await cheapestOf({
			resultJson: planResult([]),
			packages: [{ rank: 1, total: 5_000, items: ITEMS }],
		});
		expect(c!.asOf).toBe("2026-11-06T15:30:00.000Z");
	});

	it("result_json with no fx key uses item times only; not JSON at all is null", async () => {
		const { fx: _drop, ...noFx } = JSON.parse(planResult([])) as Record<string, unknown>;
		for (const resultJson of [JSON.stringify(noFx), "{}"]) {
			const c = await cheapestOf({
				resultJson,
				packages: [{ rank: 1, total: 5_000, items: ITEMS }],
			});
			expect(c!.asOf).toBe("2026-11-06T15:30:00.000Z");
		}
		expect(
			await cheapestOf({
				resultJson: "not json",
				packages: [{ rank: 1, total: 5_000, items: ITEMS }],
			}),
		).toBeNull();
	});

	it("estimates.as_of and prices_checked_at are never used as the price date", async () => {
		const c = await cheapestOf({
			resultJson: planResult([]),
			packages: [{ rank: 1, total: 5_000, items: ITEMS }],
		});
		expect(c!.asOf).not.toBe("2020-01-01T00:00:00.000Z");
	});

	it("null when a stored FX as_of is unparseable", async () => {
		expect(
			await cheapestOf({
				resultJson: planResult([
					{ from: "USD", as_of: "2026-11-05" },
					{ from: "GBP", as_of: "not a date" },
				]),
				packages: [{ rank: 1, total: 5_000, items: ITEMS }],
			}),
		).toBeNull();
	});

	it.each([
		["a number", 20261104],
		["an impossible date string", "2026-13-45"],
	])("null when a stored FX as_of is %s", async (_n, asOf) => {
		expect(
			await cheapestOf({
				resultJson: planResult([{ from: "USD", as_of: asOf }]),
				packages: [{ rank: 1, total: 5_000, items: ITEMS }],
			}),
		).toBeNull();
	});
});

describe("Jarvis contract conformance", () => {
	it("a full answer with FX-derived asOf, mixed-currency nulls and estimates parses", async () => {
		const email = freshEmail("conform");
		const id = await seedUser(email);
		await seedTrip(id, {
			eventQuery: "FX trip",
			dateFrom: day(1),
			resultJson: planResult([{ from: "USD", as_of: "2026-11-01" }]),
			packages: [{ rank: 1, total: 12_345, items: [{ isEstimate: true }, ...ITEMS] }],
		});
		await seedTrip(id, {
			eventQuery: "Mixed",
			dateFrom: day(2),
			packages: [
				{ rank: 1, total: 1, currency: "JPY" },
				{ rank: 2, total: 2, currency: "CAD" },
			],
		});
		await seedTrip(id, {
			eventQuery: "q",
			dateFrom: day(3),
			eventCity: null,
			event: { name: "Event", city: "Montréal", localDate: day(3) },
			packages: [{ rank: 1, total: 0, currency: "KWD" }],
		});
		const res = await api(email).getUpcomingTrips(email);
		// `api` already parsed it; parse again here so this test stands alone.
		expect(TagalongTripsSchema.safeParse(res).success).toBe(true);
		expect(res.trips.map((t) => t.cheapest)).toEqual([
			{ amountMinor: 12_345, currency: "CAD", isEstimate: true, asOf: "2026-11-01T00:00:00.000Z" },
			null,
			{ amountMinor: 0, currency: "KWD", isEstimate: false, asOf: "2026-11-01T10:00:00.000Z" },
		]);
	});

	it("the copied schema rejects what Jarvis would reject (it is not vacuous)", () => {
		const ok = {
			title: "T",
			date: "2026-11-20",
			city: null,
			cheapest: {
				amountMinor: 1,
				currency: "CAD",
				isEstimate: false,
				asOf: "2026-11-01T00:00:00.000Z",
			},
		};
		expect(TagalongTripsSchema.safeParse({ trips: [ok] }).success).toBe(true);
		for (const bad of [
			{ ...ok, title: "   " },
			{ ...ok, date: "2026-02-30" },
			{ ...ok, cheapest: { ...ok.cheapest, currency: "cad" } },
			{ ...ok, cheapest: { ...ok.cheapest, amountMinor: 1.5 } },
			{ ...ok, cheapest: { ...ok.cheapest, asOf: "2026-11-01" } },
		]) {
			expect(TagalongTripsSchema.safeParse({ trips: [bad] }).success).toBe(false);
		}
		expect(TagalongTripsSchema.safeParse({ trips: Array(21).fill(ok) }).success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 7. Errors
// ---------------------------------------------------------------------------

describe("internal failure", () => {
	function brokenDb(): D1Database {
		const boom = () => {
			throw new Error("D1_ERROR: no such table: users SQLITE_ERROR secret-schema-text");
		};
		return { prepare: boom, batch: boom, exec: boom, dump: boom } as unknown as D1Database;
	}

	it("rejects with exactly tagalong_unavailable and never logs the email", async () => {
		const email = freshEmail("broken");
		const logs: unknown[][] = [];
		for (const m of ["error", "warn", "log", "info", "debug"] as const) {
			vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
				logs.push(args);
			});
		}
		const err = await api(email, { DB: brokenDb() })
			.getUpcomingTrips(email)
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("tagalong_unavailable");
		expect((err as Error).message).not.toContain("SQLITE");
		expect(logs.length).toBeGreaterThan(0);
		const logged = JSON.stringify(logs);
		expect(logged).not.toContain(email);
		expect(logged.toLowerCase()).not.toContain(email.split("@")[0]!.toLowerCase());
	});

	it("a failure in the price batch also rejects (an outage is never 'no trips')", async () => {
		const { email } = await (async () => {
			const e = freshEmail("batchfail");
			const id = await seedUser(e);
			await seedTrip(id, { packages: [{ rank: 1, total: 100 }] });
			return { email: e };
		})();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const db = env.DB;
		const halfBroken = {
			prepare: db.prepare.bind(db),
			batch: () => Promise.reject(new Error("D1 batch exploded")),
		} as unknown as D1Database;
		await expect(api(email, { DB: halfBroken }).getUpcomingTrips(email)).rejects.toThrow(
			/^tagalong_unavailable$/,
		);
	});

	it("bad input and a disallowed user never touch the DB (so they can't fail)", async () => {
		const email = freshEmail("nodb");
		const a = api("someone-else@example.com", { DB: brokenDb() });
		expect(await a.getUpcomingTrips(email)).toEqual({ trips: [] });
		expect(await a.getUpcomingTrips(17)).toEqual({ trips: [] });
	});
});

// ---------------------------------------------------------------------------
// 8. Read-only
// ---------------------------------------------------------------------------

describe("read-only", () => {
	const TABLES = [
		"users",
		"saved_trips",
		"trip_requests",
		"plans",
		"events",
		"packages",
		"package_items",
		"share_links",
		"price_alerts",
	] as const;

	async function snapshot(): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		for (const t of TABLES) {
			// Table names come from the constant list above, never from input.
			const r = await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
			out[t] = JSON.stringify(r.results);
		}
		return out;
	}

	it("leaves every touched table byte-for-byte unchanged", async () => {
		const email = freshEmail("ro");
		const id = await seedUser(email);
		await seedTrip(id, {
			bestTotal: 7,
			packages: [{ rank: 1, total: 100, items: [{ isEstimate: true }] }],
		});
		await seedTrip(id, { status: "running" });
		const before = await snapshot();
		const a = api(email);
		a.ping();
		const res = await a.getUpcomingTrips(email);
		expect(res.trips).toHaveLength(2);
		await a.getUpcomingTrips("nobody@example.com");
		await a.getUpcomingTrips(null);
		expect(await snapshot()).toEqual(before);
	});
});
