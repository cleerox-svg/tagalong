/**
 * Jarvis events (docs/SETUP.md "Jarvis events"): the `tagalong.price_drop`
 * message built from a stored price_alerts row, and who gets one. Rows are
 * seeded with prepared statements against the real /migrations schema; the
 * queue is a stub that records what was sent, and every message it receives
 * is parsed against a copy of the Jarvis events v1 contract. Outbound fetch
 * (providers, FCM, Resend) is mocked; nothing reaches the network.
 */
import {
	createExecutionContext,
	createScheduledController,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import worker from "../index.js";
import {
	buildPriceDropEvent,
	EVENT_ID_RE,
	isoSeconds,
	MAX_EVENT_BYTES,
	notifyJarvisPriceDrop,
	sendJarvisEvent,
	type JarvisEvent,
	type JarvisPriceDropEvent,
} from "../lib/jarvis-events.js";
import { checkSavedTrips } from "../planning/alerts.js";
import { call, json, mockFetch, postJson, signedInUser } from "./helpers.js";

const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Contract: a copy of Jarvis events v1 (`tagalong.price_drop`). Jarvis drops a
// message that fails this, so every message handed to a stub queue is parsed.
// ---------------------------------------------------------------------------

const WITH_SECONDS = /T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const Money = z.strictObject({
	amountMinor: z.number().int().min(0).max(10_000_000_000),
	currency: z.string().regex(/^[A-Z]{3}$/),
});
const JarvisEventSchema = z
	.strictObject({
		app: z.literal("tagalong"),
		contractVersion: z.literal(1),
		eventId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
		type: z.literal("tagalong.price_drop"),
		userEmail: z
			.string()
			.min(1)
			.max(320)
			.refine((s) => s === s.trim().toLowerCase(), "email not trimmed + lowercase"),
		occurredAt: z.iso.datetime({ offset: true }).regex(WITH_SECONDS),
		payload: z.strictObject({
			tripTitle: z.string().min(1).max(120),
			tripDate: z.iso.date(),
			was: Money,
			now: Money.extend({
				isEstimate: z.boolean(),
				asOf: z.iso.datetime({ offset: true }).regex(WITH_SECONDS),
			}).strict(),
		}),
	})
	.refine((e) => e.payload.was.currency === e.payload.now.currency, "was/now currency differ")
	.refine(
		(e) => new TextEncoder().encode(JSON.stringify(e)).byteLength <= 4096,
		"message over 4096 bytes",
	);

/** Messages a stub queue received that fail the contract. Must stay empty. */
const nonConformant: string[] = [];
/** Messages checked against the contract, so the check can't pass vacuously. */
let conformanceChecks = 0;

afterEach(() => {
	vi.restoreAllMocks();
	expect(nonConformant).toEqual([]);
});

afterAll(() => {
	expect(conformanceChecks).toBeGreaterThanOrEqual(8);
});

/** A queue that records each message (and the options) and checks it against the contract. */
function stubQueue(fail = false) {
	const sent: JarvisPriceDropEvent[] = [];
	const options: unknown[] = [];
	const send = vi.fn(async (body: unknown, opts?: unknown) => {
		if (fail) throw new Error("queue down");
		const parsed = JarvisEventSchema.safeParse(body);
		if (!parsed.success) nonConformant.push(`${parsed.error.message}\n${JSON.stringify(body)}`);
		conformanceChecks++;
		sent.push(body as JarvisPriceDropEvent);
		options.push(opts);
	});
	const queue = { send } as unknown as Queue;
	return { queue, sent, send, options };
}

function withEnv(allowlist: string | undefined, queue?: Queue, base: Env = env): Env {
	const e = { ...base } as Env;
	if (allowlist === undefined) delete (e as { JARVIS_READ_EMAILS?: string }).JARVIS_READ_EMAILS;
	else e.JARVIS_READ_EMAILS = allowlist;
	if (queue) e.JARVIS_EVENTS = queue;
	else delete (e as Partial<Env>).JARVIS_EVENTS;
	return e;
}

interface SeedOpts {
	googleSub?: string;
	isEstimate?: boolean;
	/** price_alerts.new_total_minor (default: the package total). */
	newTotal?: number;
	oldTotal?: number;
	/** The cheapest package's total. */
	pkgTotal?: number;
	/** Currency of the package and its item. */
	pkgCurrency?: string;
	/** Currency recorded on the alert. */
	alertCurrency?: string;
	alertId?: string;
	/** The event's name; null leaves the plan without an event (title falls back to the query). */
	eventName?: string | null;
	eventQuery?: string;
	email?: string;
	deletedAt?: string | null;
	/** fetched_at of the single package item. */
	fetchedAt?: string;
	createdAt?: string;
	/** The owner's saved_trips row for the trip: alerts on (default), off, or not saved. */
	saved?: "on" | "off" | "none";
}

interface Seeded {
	/** The trimmed, lowercased address. */
	email: string;
	/** users.email exactly as stored (padded, mixed case): what the cron passes. */
	storedEmail: string;
	userId: string;
	alertId: string;
	planId: string;
	tripId: string;
}

/** A user, a trip with an event, a finished plan with one package, and an alert on it. */
async function seedAlert(opts: SeedOpts = {}): Promise<Seeded> {
	const email = opts.email ?? `Ev-${uid()}@Example.com`;
	const userId = `je-user-${uid()}`;
	await env.DB.prepare(
		`INSERT INTO users (id, google_sub, email, display_name, birthdate_verified_18, home_currency, deleted_at)
		 VALUES (?, ?, ?, 'Jarvis Events', 1, 'CAD', ?)`,
	)
		.bind(
			userId,
			opts.googleSub ?? `1${Math.floor(Math.random() * 1e15)}`,
			` ${email} `,
			opts.deletedAt ?? null,
		)
		.run();
	const tripId = `je-trip-${uid()}`;
	await env.DB.prepare(
		`INSERT INTO trip_requests (id, user_id, raw_text, origin_city, origin_lat, origin_lng, origin_country,
		   event_query, event_city, date_from, date_to, party_size, budget_minor, budget_currency, budget_scope, prefs_json)
		 VALUES (?, ?, 'raw', 'Ottawa', 45.42, -75.69, 'CA', ?, 'Toronto', '2027-03-01', '2027-03-02', 2, 99999, 'CAD', 'total', '{}')`,
	)
		.bind(tripId, userId, opts.eventQuery ?? "Leafs game")
		.run();
	// packages.event_id is NOT NULL, so the event row always exists; a null
	// eventName only leaves it off the plan.
	const eventId = `je-evt-${uid()}`;
	await env.DB.prepare(
		`INSERT INTO events (id, provider, provider_event_id, name, city, country, local_date, fetched_at)
		 VALUES (?, 'manual', ?, ?, 'Toronto', 'CA', '2027-03-01', '2026-01-01T00:00:00Z')`,
	)
		.bind(
			eventId,
			eventId,
			opts.eventName === undefined
				? "Maple Leafs at Bruins"
				: (opts.eventName ?? "Package-only event"),
		)
		.run();
	const planId = `je-plan-${uid()}`;
	await env.DB.prepare(
		`INSERT INTO plans (id, user_id, trip_request_id, event_id, status, result_json)
		 VALUES (?, ?, ?, ?, 'done', '{}')`,
	)
		.bind(planId, userId, tripId, opts.eventName === null ? null : eventId)
		.run();
	const pkgTotal = opts.pkgTotal ?? 45000;
	const pkgCurrency = opts.pkgCurrency ?? "CAD";
	const newTotal = opts.newTotal ?? pkgTotal;
	const pkgId = `je-pkg-${uid()}`;
	await env.DB.prepare(
		`INSERT INTO packages (id, plan_id, rank, label, event_id, total_minor, currency, score, summary_text, details_json)
		 VALUES (?, ?, 1, 'cheapest', ?, ?, ?, 1, 'summary', '{}')`,
	)
		.bind(pkgId, planId, eventId, pkgTotal, pkgCurrency)
		.run();
	await env.DB.prepare(
		`INSERT INTO package_items (id, package_id, position, kind, title, provider, amount_minor, currency,
		   is_estimate, booking_url, fetched_at, method)
		 VALUES (?, ?, 0, 'ticket', 'Item', 'ticketmaster', ?, ?, ?, 'https://book.example/x', ?, 'live')`,
	)
		.bind(
			`je-item-${uid()}`,
			pkgId,
			pkgTotal,
			pkgCurrency,
			opts.isEstimate ? 1 : 0,
			opts.fetchedAt ?? "2026-11-10T08:00:00.000Z",
		)
		.run();
	const alertId = opts.alertId ?? uid();
	await env.DB.prepare(
		`INSERT INTO price_alerts (id, user_id, trip_request_id, plan_id, old_total_minor, new_total_minor, currency, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			alertId,
			userId,
			tripId,
			planId,
			opts.oldTotal ?? 50000,
			newTotal,
			opts.alertCurrency ?? pkgCurrency,
			opts.createdAt ?? "2026-11-14T09:30:12.345Z",
		)
		.run();
	if ((opts.saved ?? "on") !== "none") {
		// last_checked_at far ahead: the cron tests' re-check never picks these up.
		await env.DB.prepare(
			`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, alerts_enabled, best_total_minor, currency, last_checked_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, '9999-01-01T00:00:00.000Z')`,
		)
			.bind(
				userId,
				planId,
				tripId,
				planId,
				opts.saved === "off" ? 0 : 1,
				newTotal,
				opts.alertCurrency ?? pkgCurrency,
			)
			.run();
	}
	return {
		email: email.trim().toLowerCase(),
		storedEmail: ` ${email} `,
		userId,
		alertId,
		planId,
		tripId,
	};
}

describe("tagalong.price_drop event", () => {
	it("is built from the stored alert and cheapest package", async () => {
		const a = await seedAlert({ isEstimate: true });
		const ev = await buildPriceDropEvent(withEnv(a.email), a.alertId, a.userId);
		expect(ev).toEqual({
			app: "tagalong",
			contractVersion: 1,
			eventId: `pd_${a.alertId}`,
			type: "tagalong.price_drop",
			userEmail: a.email,
			occurredAt: "2026-11-14T09:30:12Z",
			payload: {
				tripTitle: "Maple Leafs at Bruins",
				tripDate: "2027-03-01",
				was: { amountMinor: 50000, currency: "CAD" },
				now: {
					amountMinor: 45000,
					currency: "CAD",
					isEstimate: true,
					asOf: "2026-11-10T08:00:00.000Z",
				},
			},
		});
		expect(ev!.eventId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
	});

	it("is not built off the allowlist, for an Apple-only account, or another user's id", async () => {
		const a = await seedAlert();
		expect(await buildPriceDropEvent(withEnv("someone@else.com"), a.alertId, a.userId)).toBeNull();
		expect(await buildPriceDropEvent(withEnv(a.email), a.alertId, "not-the-owner")).toBeNull();
		const apple = await seedAlert({ googleSub: `apple:${uid()}` });
		expect(await buildPriceDropEvent(withEnv(apple.email), apple.alertId, apple.userId)).toBeNull();
	});

	it("is not built when the alert's total isn't the stored cheapest package", async () => {
		const a = await seedAlert({ newTotal: 44000 });
		expect(await buildPriceDropEvent(withEnv(a.email), a.alertId, a.userId)).toBeNull();
	});

	it("is queued as an object, and a send failure or missing binding never throws", async () => {
		const a = await seedAlert();
		const ok = stubQueue();
		await notifyJarvisPriceDrop(withEnv(a.email, ok.queue), a.alertId, a.userId, a.storedEmail);
		expect(ok.sent).toHaveLength(1);
		expect(ok.sent[0]).toMatchObject({ eventId: `pd_${a.alertId}` });

		const down = stubQueue(true);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			notifyJarvisPriceDrop(withEnv(a.email, down.queue), a.alertId, a.userId, a.storedEmail),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toContain(a.email);
		// Only the error's name is logged, never its message.
		expect(JSON.stringify(warn.mock.calls)).not.toContain("queue down");
		warn.mockRestore();

		await expect(
			notifyJarvisPriceDrop(withEnv(a.email), a.alertId, a.userId, a.storedEmail),
		).resolves.toBeUndefined();
		expect(await sendJarvisEvent(withEnv(a.email), {} as JarvisEvent)).toBe(false);
	});

	it("formats occurredAt to whole seconds in UTC", () => {
		expect(isoSeconds("2026-11-14T09:30:12.999Z")).toBe("2026-11-14T09:30:12Z");
		expect(isoSeconds("nope")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Unit level: allowlist, money, title, eventId, size, and the no-op guards.
// ---------------------------------------------------------------------------

/** Builds and queues one alert's event; returns what the queue received. */
async function notify(
	allowlist: string | undefined,
	a: { alertId: string; userId: string; storedEmail: string },
) {
	const q = stubQueue();
	await notifyJarvisPriceDrop(withEnv(allowlist, q.queue), a.alertId, a.userId, a.storedEmail);
	return q;
}

describe("allowlist (same rule as the read API)", () => {
	it("sends only to an address on JARVIS_READ_EMAILS", async () => {
		const a = await seedAlert();
		expect((await notify("someone@else.com", a)).sent).toHaveLength(0);
		expect((await notify(`x${a.email}`, a)).sent).toHaveLength(0);
		const q = await notify(`other@x.com, ${a.email}; third@y.com`, a);
		expect(q.sent).toHaveLength(1);
		expect(q.send).toHaveBeenCalledWith(q.sent[0], { contentType: "json" });
	});

	it("normalises case and whitespace on both sides; the event carries the trimmed lowercase address", async () => {
		const local = `MiXeD-${uid()}`;
		const a = await seedAlert({ email: `  ${local}@ExAmPle.COM  ` });
		const lower = `${local.toLowerCase()}@example.com`;
		const q1 = await notify(`\t ${local.toUpperCase()}@EXAMPLE.COM \n`, a);
		expect(q1.sent).toHaveLength(1);
		expect(q1.sent[0]!.userEmail).toBe(lower);
		const q2 = await notify(lower, a);
		expect(q2.sent).toHaveLength(1);
		expect(q2.sent[0]!.userEmail).toBe(lower);
	});

	it("sends nothing for a deleted account", async () => {
		const a = await seedAlert({ deletedAt: "2026-11-01T00:00:00Z" });
		expect((await notify(a.email, a)).sent).toHaveLength(0);
	});

	it("sends nothing for an Apple-only or tombstoned (deleted:) account", async () => {
		const apple = await seedAlert({ googleSub: `apple:${uid()}` });
		expect((await notify(apple.email, apple)).sent).toHaveLength(0);
		const tomb = await seedAlert({ googleSub: `deleted:${uid()}` });
		expect((await notify(tomb.email, tomb)).sent).toHaveLength(0);
	});

	it("sends nothing when two live Google accounts share the address", async () => {
		const a = await seedAlert();
		await env.DB.prepare(
			`INSERT INTO users (id, google_sub, email, display_name, birthdate_verified_18, home_currency)
			 VALUES (?, ?, ?, 'Twin', 1, 'CAD')`,
		)
			.bind(`je-twin-${uid()}`, `2${Math.floor(Math.random() * 1e15)}`, a.email.toUpperCase())
			.run();
		expect((await notify(a.email, a)).sent).toHaveLength(0);
	});

	it("an allowlist of separators only sends nothing", async () => {
		const a = await seedAlert();
		expect((await notify(" ,; ", a)).sent).toHaveLength(0);
	});
});

describe("no binding or no allowlist: a no-op without even a DB read", () => {
	/** An env whose DB fails the test if touched. */
	function trapDb(allowlist: string | undefined, queue?: Queue) {
		const prepare = vi.fn(() => {
			throw new Error("DB must not be read");
		});
		const batch = vi.fn(() => {
			throw new Error("DB must not be read");
		});
		const e = withEnv(allowlist, queue);
		(e as { DB: unknown }).DB = { prepare, batch };
		return { e, prepare, batch };
	}

	it.each([
		["unset allowlist", undefined, true],
		["empty allowlist", "", true],
		["missing binding", "someone@example.com", false],
		["neither", undefined, false],
	])("%s", async (_name, allowlist, withQueue) => {
		const q = stubQueue();
		const warn = vi.spyOn(console, "warn");
		const t = trapDb(allowlist, withQueue ? q.queue : undefined);
		await expect(
			notifyJarvisPriceDrop(t.e, "some-alert-id", "some-user", "someone@example.com"),
		).resolves.toBeUndefined();
		expect(t.prepare).not.toHaveBeenCalled();
		expect(t.batch).not.toHaveBeenCalled();
		expect(q.send).not.toHaveBeenCalled();
		// Returned before the try: nothing failed, so nothing was logged.
		expect(warn).not.toHaveBeenCalled();
	});

	it.each([
		["an owner not on the allowlist", "other@example.com"],
		["an allowlisted address plus a suffix", "someone@example.com.evil"],
		["an owner with no email (Apple, none shared)", null],
		["a blank owner email", "   "],
	])("%s: no DB read, nothing sent", async (_name, ownerEmail) => {
		const q = stubQueue();
		const warn = vi.spyOn(console, "warn");
		const t = trapDb("someone@example.com", q.queue);
		await expect(
			notifyJarvisPriceDrop(t.e, "some-alert-id", "some-user", ownerEmail),
		).resolves.toBeUndefined();
		expect(t.prepare).not.toHaveBeenCalled();
		expect(t.batch).not.toHaveBeenCalled();
		expect(q.send).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("an allowlisted owner (any case or padding) passes the pre-check and reads the DB", async () => {
		const q = stubQueue();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const t = trapDb("someone@example.com", q.queue);
		await notifyJarvisPriceDrop(t.e, "some-alert-id", "some-user", "  SomeOne@Example.COM ");
		expect(t.prepare).toHaveBeenCalled();
		expect(q.send).not.toHaveBeenCalled();
		// The trap's failure is logged by error name only: no message text.
		expect(warn).toHaveBeenCalledWith("jarvis price-drop event failed", "Error");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("must not be read");
	});
});

describe("the full account rule still applies after the pre-check", () => {
	it("an allowlisted address passed in that isn't the alert owner's stored one sends nothing", async () => {
		const a = await seedAlert();
		const q = stubQueue();
		await notifyJarvisPriceDrop(
			withEnv("someone@example.com", q.queue),
			a.alertId,
			a.userId,
			"someone@example.com",
		);
		expect(q.send).not.toHaveBeenCalled();
	});
});

describe("only a live saved trip, with alerts on, of the alert's owner", () => {
	it("sends nothing when the trip isn't saved", async () => {
		const a = await seedAlert({ saved: "none" });
		expect((await notify(a.email, a)).sent).toHaveLength(0);
	});

	it("sends nothing when the saved trip has alerts turned off", async () => {
		const a = await seedAlert({ saved: "off" });
		expect((await notify(a.email, a)).sent).toHaveLength(0);
	});

	it("sends once alerts are on again", async () => {
		const a = await seedAlert({ saved: "off" });
		await env.DB.prepare(
			"UPDATE saved_trips SET alerts_enabled = 1 WHERE user_id = ? AND trip_request_id = ?",
		)
			.bind(a.userId, a.tripId)
			.run();
		expect((await notify(a.email, a)).sent).toHaveLength(1);
	});

	it("sends nothing when only another user saved the trip", async () => {
		const a = await seedAlert({ saved: "none" });
		const otherId = `je-other-${uid()}`;
		await env.DB.prepare(
			`INSERT INTO users (id, google_sub, email, display_name, birthdate_verified_18, home_currency)
			 VALUES (?, ?, ?, 'Other', 1, 'CAD')`,
		)
			.bind(otherId, `3${Math.floor(Math.random() * 1e15)}`, `other-${uid()}@example.com`)
			.run();
		await env.DB.prepare(
			`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, alerts_enabled, currency, last_checked_at)
			 VALUES (?, ?, ?, ?, 1, 'CAD', '9999-01-01T00:00:00.000Z')`,
		)
			.bind(otherId, a.planId, a.tripId, a.planId)
			.run();
		expect((await notify(a.email, a)).sent).toHaveLength(0);
	});

	it("sends nothing when the trip request belongs to another user", async () => {
		const a = await seedAlert();
		const otherId = `je-other-${uid()}`;
		await env.DB.prepare(
			`INSERT INTO users (id, google_sub, email, display_name, birthdate_verified_18, home_currency)
			 VALUES (?, ?, ?, 'Other', 1, 'CAD')`,
		)
			.bind(otherId, `4${Math.floor(Math.random() * 1e15)}`, `other-${uid()}@example.com`)
			.run();
		await env.DB.prepare("UPDATE trip_requests SET user_id = ? WHERE id = ?")
			.bind(otherId, a.tripId)
			.run();
		expect((await notify(a.email, a)).sent).toHaveLength(0);
	});
});

describe("money comes straight from the stored price_alerts row", () => {
	it.each([
		["CAD", 50000, 45000],
		["JPY", 5000, 4500],
		["KWD", 12345, 12000],
		["USD", 1, 0],
	])("%s: amounts and currency equal the row, unconverted", async (cur, oldTotal, pkgTotal) => {
		const a = await seedAlert({ pkgCurrency: cur, oldTotal, pkgTotal });
		const q = await notify(a.email, a);
		expect(q.sent).toHaveLength(1);
		const row = await env.DB.prepare(
			"SELECT old_total_minor, new_total_minor, currency FROM price_alerts WHERE id = ?",
		)
			.bind(a.alertId)
			.first<{ old_total_minor: number; new_total_minor: number; currency: string }>();
		expect(q.sent[0]!.payload.was).toEqual({ amountMinor: row!.old_total_minor, currency: cur });
		expect(q.sent[0]!.payload.now).toMatchObject({
			amountMinor: row!.new_total_minor,
			currency: cur,
		});
		expect(row).toEqual({ old_total_minor: oldTotal, new_total_minor: pkgTotal, currency: cur });
	});

	it("sends nothing when the alert's currency is not the package's", async () => {
		const a = await seedAlert({ pkgCurrency: "CAD", alertCurrency: "USD" });
		expect((await notify(a.email, a)).sent).toHaveLength(0);
	});

	it("sends nothing when the alert's total is not the package's", async () => {
		const a = await seedAlert({ pkgTotal: 45000, newTotal: 45001 });
		expect((await notify(a.email, a)).sent).toHaveLength(0);
	});

	it("sends nothing when a stored amount is outside the contract", async () => {
		const neg = await seedAlert({ oldTotal: -1 });
		expect((await notify(neg.email, neg)).sent).toHaveLength(0);
		const huge = await seedAlert({ oldTotal: 10_000_000_001 });
		expect((await notify(huge.email, huge)).sent).toHaveLength(0);
		const lower = await seedAlert({ pkgCurrency: "cad" });
		expect((await notify(lower.email, lower)).sent).toHaveLength(0);
	});

	it("labels an estimate as one, with asOf from the stored item", async () => {
		const a = await seedAlert({ isEstimate: true, fetchedAt: "2026-11-09T07:06:05.000Z" });
		const q = await notify(a.email, a);
		expect(q.sent[0]!.payload.now).toMatchObject({
			isEstimate: true,
			asOf: "2026-11-09T07:06:05.000Z",
		});
		const live = await seedAlert({ isEstimate: false });
		expect((await notify(live.email, live)).sent[0]!.payload.now.isEstimate).toBe(false);
	});
});

describe("title, eventId and size", () => {
	it("clips tripTitle at 120 characters", async () => {
		const a = await seedAlert({ eventName: `  ${"T".repeat(200)}  ` });
		const q = await notify(a.email, a);
		expect(q.sent[0]!.payload.tripTitle).toBe("T".repeat(120));
	});

	it("never splits a surrogate pair when clipping", async () => {
		const a = await seedAlert({ eventName: `${"a".repeat(119)}\u{1F3D2}tail` });
		const title = (await notify(a.email, a)).sent[0]!.payload.tripTitle;
		expect(title).toBe("a".repeat(119));
	});

	it("falls back to the trip's query when the plan has no event, or the name is blank", async () => {
		const none = await seedAlert({ eventName: null, eventQuery: "Raptors home opener" });
		expect((await notify(none.email, none)).sent[0]!.payload.tripTitle).toBe("Raptors home opener");
		const blank = await seedAlert({ eventName: "   ", eventQuery: "Jays opener" });
		expect((await notify(blank.email, blank)).sent[0]!.payload.tripTitle).toBe("Jays opener");
		const neither = await seedAlert({ eventName: null, eventQuery: "   " });
		expect((await notify(neither.email, neither)).sent).toHaveLength(0);
	});

	it("eventId is pd_<alert id>; an id that can't make a valid eventId sends nothing", async () => {
		const a = await seedAlert();
		expect((await notify(a.email, a)).sent[0]!.eventId).toBe(`pd_${a.alertId}`);
		expect(EVENT_ID_RE.test(`pd_${a.alertId}`)).toBe(true);

		const dotted = await seedAlert({ alertId: `a.b.c.${uid()}` });
		expect((await notify(dotted.email, dotted)).sent).toHaveLength(0);
		const short = await seedAlert({ alertId: `x${uid().slice(0, 3)}` });
		expect(`pd_${short.alertId}`.length).toBeLessThan(8);
		expect((await notify(short.email, short)).sent).toHaveLength(0);
		const long = await seedAlert({ alertId: "a".repeat(126) });
		expect((await notify(long.email, long)).sent).toHaveLength(0);
		const max = await seedAlert({ alertId: "b".repeat(125) });
		expect((await notify(max.email, max)).sent[0]!.eventId).toBe(`pd_${"b".repeat(125)}`);
	});

	it("occurredAt is the alert's creation time, whole seconds UTC", async () => {
		const a = await seedAlert({ createdAt: "2026-11-14T10:00:59.999Z" });
		expect((await notify(a.email, a)).sent[0]!.occurredAt).toBe("2026-11-14T10:00:59Z");
	});

	it("a message over 4096 bytes (counted in UTF-8 bytes) is not sent; exactly 4096 is", async () => {
		const base: JarvisPriceDropEvent = {
			app: "tagalong",
			contractVersion: 1,
			eventId: "pd_size-test-0001",
			type: "tagalong.price_drop",
			userEmail: "size@example.com",
			occurredAt: "2026-11-14T09:30:12Z",
			payload: {
				tripTitle: "",
				tripDate: "2027-03-01",
				was: { amountMinor: 50000, currency: "CAD" },
				now: {
					amountMinor: 45000,
					currency: "CAD",
					isEstimate: false,
					asOf: "2026-11-10T08:00:00.000Z",
				},
			},
		};
		const bytes = (e: unknown) => new TextEncoder().encode(JSON.stringify(e)).byteLength;
		const pad = MAX_EVENT_BYTES - bytes(base);
		const at = (title: string) => ({ ...base, payload: { ...base.payload, tripTitle: title } });
		expect(bytes(at("a".repeat(pad)))).toBe(4096);

		// Sent unvalidated on purpose (the title is past 120): this checks only the size gate.
		const send = vi.fn(async () => {});
		const e = withEnv("size@example.com", { send } as unknown as Queue);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await sendJarvisEvent(e, at("a".repeat(pad)))).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		expect(await sendJarvisEvent(e, at("a".repeat(pad + 1)))).toBe(false);
		// Fewer characters than 4096 bytes would allow, but more bytes: still refused.
		const multi = "é".repeat(Math.ceil((pad + 1) / 2));
		expect(multi.length).toBeLessThan(pad);
		expect(await sendJarvisEvent(e, at(multi))).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("size@example.com");
	});
});

// ---------------------------------------------------------------------------
// Cron level: the scheduled re-check of a real saved trip, end to end.
// ---------------------------------------------------------------------------

let fcmEnv: Env;
beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const der = new Uint8Array(
		(await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
	);
	let bin = "";
	for (const b of der) bin += String.fromCharCode(b);
	const pem = `-----BEGIN PRIVATE KEY-----\n${(btoa(bin).match(/.{1,64}/g) ?? []).join("\n")}\n-----END PRIVATE KEY-----\n`;
	fcmEnv = {
		...env,
		FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
			project_id: "tagalong-jarvis-events-test",
			client_email: "push@tagalong-jarvis-events-test.iam.gserviceaccount.com",
			private_key: pem,
		}),
	};
});

let day = 0;
/** Future dates distinct per test, so cached provider answers never leak between tests. */
const nextDate = () => new Date(Date.UTC(2028, 8, 1 + 3 * day++)).toISOString().slice(0, 10);

/** Ticketmaster + FX + Resend + FCM mocks; `min` is the cheapest face value. */
function providers(id: string, date: string, min: number) {
	const emails: Array<Record<string, unknown>> = [];
	const pushes: string[] = [];
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
			emails.push(JSON.parse(String(init?.body)));
			return json({ id: "email_1" });
		},
		(url) =>
			url.host === "oauth2.googleapis.com"
				? json({ access_token: "ya29.jarvis", expires_in: 3600 })
				: undefined,
		(url, init) => {
			if (url.host !== "fcm.googleapis.com") return undefined;
			pushes.push(String(init?.body));
			return json({ name: "projects/x/messages/1" });
		},
	);
	return { emails, pushes };
}

/** A signed-in (real Google) user with one saved trip whose cheapest face value was $45. */
async function savedTrip(tmId: string, date: string) {
	const u = await signedInUser();
	providers(tmId, date, 45);
	const res = await postJson(
		"/plans",
		{
			origin: { label: "Toronto, ON, Canada", lat: 43.6532, lng: -79.3832, country_code: "CA" },
			event: { query: `Leafs ${tmId} ${uid().slice(0, 6)}` },
			date_from: date,
			date_to: date,
			party_size: 2,
			budget: { amount_minor: 400000, currency: "CAD", scope: "total" },
			prefs: { transport: "any", stay: "any", max_nights: 2, seat_quality: "any", vibe_tags: [] },
		},
		u.cookie,
	);
	expect(res.status).toBe(202);
	const { id: planId } = await res.json<{ id: string }>();
	const p = await (await call(`/plans/${planId}`, { cookie: u.cookie })).json<{ status: string }>();
	expect(p.status).toBe("done");
	expect((await postJson(`/plans/${planId}/save`, {}, u.cookie)).status).toBe(200);
	vi.restoreAllMocks();
	return { ...u, email: `${u.id}@example.com` };
}

async function addDevice(userId: string) {
	await env.DB.prepare(
		"INSERT INTO push_devices (id, user_id, platform, token) VALUES (?, ?, 'android', ?)",
	)
		.bind(uid(), userId, `tok-${uid()}`)
		.run();
}

interface AlertRowT {
	id: string;
	trip_request_id: string;
	old_total_minor: number;
	new_total_minor: number;
	currency: string;
	emailed_at: string | null;
	pushed_at: string | null;
}
const alertsFor = async (userId: string) =>
	(
		await env.DB.prepare("SELECT * FROM price_alerts WHERE user_id = ?")
			.bind(userId)
			.all<AlertRowT>()
	).results;

/** Every console call's arguments, serialised, for privacy checks. */
function captureConsole() {
	const lines: string[] = [];
	for (const m of ["log", "info", "warn", "error", "debug"] as const) {
		vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
			lines.push(
				args
					.map((a) => (a instanceof Error ? `${a.name} ${a.message}` : JSON.stringify(a)))
					.join(" "),
			);
		});
	}
	return lines;
}

describe("cron: checkSavedTrips sends Jarvis one event per recorded drop", () => {
	it("an allowlisted user's alert-worthy re-check queues exactly one conformant event", async () => {
		const date = nextDate();
		const u = await savedTrip("JE-CRON-1", date);
		const q = stubQueue();
		providers("JE-CRON-1", date, 20);
		const r = await checkSavedTrips(withEnv(` ${u.email.toUpperCase()} `, q.queue));
		expect(r.alerts).toBeGreaterThanOrEqual(1);

		const [alert, ...rest] = await alertsFor(u.id);
		expect(rest).toHaveLength(0);
		const mine = q.sent.filter((m) => m.userEmail === u.email);
		expect(mine).toHaveLength(1);
		expect(q.sent).toHaveLength(1); // nobody else in this run is on the allowlist
		const saved = await env.DB.prepare(
			"SELECT currency FROM saved_trips WHERE user_id = ? AND trip_request_id = ?",
		)
			.bind(u.id, alert!.trip_request_id)
			.first<{ currency: string }>();
		expect(mine[0]).toMatchObject({
			eventId: `pd_${alert!.id}`,
			userEmail: u.email,
			payload: {
				tripTitle: "Maple Leafs at Bruins",
				tripDate: date,
				was: { amountMinor: alert!.old_total_minor, currency: saved!.currency },
				now: { amountMinor: alert!.new_total_minor, currency: saved!.currency },
			},
		});
		expect(alert!.currency).toBe(saved!.currency);
		expect(mine[0]!.payload.now.amountMinor).toBeLessThan(mine[0]!.payload.was.amountMinor);
	});

	it("a re-check that isn't alert-worthy sends nothing", async () => {
		const date = nextDate();
		const u = await savedTrip("JE-CRON-2", date);
		const q = stubQueue();
		providers("JE-CRON-2", date, 45); // same price: no drop
		const r = await checkSavedTrips(withEnv(u.email, q.queue));
		expect(r.checked).toBeGreaterThanOrEqual(1);
		expect(await alertsFor(u.id)).toHaveLength(0);
		expect(q.send).not.toHaveBeenCalled();
	});

	it("an owner not on the allowlist still gets the alert recorded, but Jarvis hears nothing", async () => {
		const date = nextDate();
		const u = await savedTrip("JE-CRON-3", date);
		const q = stubQueue();
		providers("JE-CRON-3", date, 20);
		await checkSavedTrips(withEnv("someone-else@example.com", q.queue));
		expect(await alertsFor(u.id)).toHaveLength(1);
		expect(q.send).not.toHaveBeenCalled();
	});

	it("an alert recorded in another currency than the stored package sends nothing", async () => {
		const date = nextDate();
		const u = await savedTrip("JE-CRON-4", date);
		// The saved trip's currency is what the alert records; make it disagree with the plan's packages.
		await env.DB.prepare("UPDATE saved_trips SET currency = 'USD' WHERE user_id = ?")
			.bind(u.id)
			.run();
		const q = stubQueue();
		providers("JE-CRON-4", date, 20);
		await checkSavedTrips(withEnv(u.email, q.queue));
		const alerts = await alertsFor(u.id);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.currency).toBe("USD");
		expect(q.send).not.toHaveBeenCalled();
	});

	it("a queue that throws doesn't stop the check, the alert row, the push or the email, and logs no email", async () => {
		const date = nextDate();
		const u = await savedTrip("JE-CRON-5", date);
		await addDevice(u.id);
		const down = stubQueue(true);
		const { emails, pushes } = providers("JE-CRON-5", date, 20);
		const logs = captureConsole();
		const r = await checkSavedTrips(
			withEnv(u.email, down.queue, { ...fcmEnv, RESEND_API_KEY: "re_test" } as Env),
		);
		expect(r.alerts).toBeGreaterThanOrEqual(1);
		expect(down.send).toHaveBeenCalledTimes(1);

		const alerts = await alertsFor(u.id);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.emailed_at).not.toBeNull();
		expect(alerts[0]!.pushed_at).not.toBeNull();
		expect(pushes).toHaveLength(1);
		expect(emails.filter((m) => (m.to as string[])[0] === u.email)).toHaveLength(1);

		expect(logs.some((l) => l.includes("jarvis event send failed"))).toBe(true);
		const all = logs.join("\n");
		expect(all).not.toContain(u.email);
		expect(all.toLowerCase()).not.toContain(u.email.toLowerCase());
	});

	it("a queue that rejects asynchronously after a delay is still isolated", async () => {
		const date = nextDate();
		const u = await savedTrip("JE-CRON-6", date);
		const send = vi.fn(
			() => new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 5)),
		);
		providers("JE-CRON-6", date, 20);
		captureConsole();
		await expect(
			checkSavedTrips(withEnv(u.email, { send } as unknown as Queue)),
		).resolves.toMatchObject({ alerts: expect.any(Number) });
		expect(send).toHaveBeenCalledTimes(1);
		expect(await alertsFor(u.id)).toHaveLength(1);
	});
});

describe("cron: the scheduled handler", () => {
	/** A ctx that records every waitUntil and can drain them, including ones added while draining. */
	function capturingCtx() {
		const pending: Promise<unknown>[] = [];
		let calls = 0;
		const ctx = {
			waitUntil: (p: Promise<unknown>) => {
				calls++;
				pending.push(p);
			},
			passThroughOnException: () => {},
			props: {},
		} as unknown as ExecutionContext;
		const drain = async () => {
			while (pending.length) await pending.shift();
		};
		return { ctx, drain, calls: () => calls };
	}

	it("hands the Jarvis send to waitUntil and queues exactly one event", async () => {
		const date = nextDate();
		const u = await savedTrip("JE-SCHED-1", date);
		const q = stubQueue();
		providers("JE-SCHED-1", date, 20);
		captureConsole();
		const c = capturingCtx();
		await worker.scheduled(
			createScheduledController({ scheduledTime: Date.now(), cron: "23 */6 * * *" }),
			withEnv(u.email, q.queue),
			c.ctx,
		);
		await c.drain();
		// The price check, the prune, and the Jarvis send for the one recorded drop.
		expect(c.calls()).toBe(3);
		expect(await alertsFor(u.id)).toHaveLength(1);
		expect(q.sent).toHaveLength(1);
		expect(q.sent[0]!.userEmail).toBe(u.email);
	});

	it("with a non-alert-worthy re-check, nothing is queued and no extra waitUntil is made", async () => {
		const date = nextDate();
		const u = await savedTrip("JE-SCHED-2", date);
		const q = stubQueue();
		providers("JE-SCHED-2", date, 45);
		captureConsole();
		const c = capturingCtx();
		await worker.scheduled(
			createScheduledController({ scheduledTime: Date.now(), cron: "23 */6 * * *" }),
			withEnv(u.email, q.queue),
			c.ctx,
		);
		await c.drain();
		expect(c.calls()).toBe(2);
		expect(await alertsFor(u.id)).toHaveLength(0);
		expect(q.send).not.toHaveBeenCalled();
	});

	it("a throwing queue under the real execution context leaves the run and the alert intact", async () => {
		const date = nextDate();
		const u = await savedTrip("JE-SCHED-3", date);
		const down = stubQueue(true);
		providers("JE-SCHED-3", date, 20);
		const logs = captureConsole();
		const ctx = createExecutionContext();
		await worker.scheduled(
			createScheduledController({ scheduledTime: Date.now(), cron: "23 */6 * * *" }),
			withEnv(u.email, down.queue),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(down.send).toHaveBeenCalledTimes(1);
		expect(await alertsFor(u.id)).toHaveLength(1);
		expect(logs.some((l) => l.includes("saved-trip price check failed"))).toBe(false);
		expect(logs.join("\n")).not.toContain(u.email);
	});
});
