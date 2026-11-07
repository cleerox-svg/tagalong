import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { vi } from "vitest";
import { startSession } from "../auth/session.js";
import app from "../index.js";
import type { AppEnv } from "../lib/http.js";

export const WEB = "https://tagalong.averrow.com";
export const API = "https://tagalong-api.averrow.com";

/** Calls the Worker in-process and waits for its waitUntil work (the planning run). */
export async function call(
	path: string,
	init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.cookie) headers.set("Cookie", init.cookie);
	const ctx = createExecutionContext();
	const res = await app.fetch(new Request(`${API}${path}`, { ...init, headers }), env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

export const postJson = (path: string, body: unknown, cookie?: string, origin = WEB) =>
	call(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: origin },
		body: JSON.stringify(body),
		...(cookie ? { cookie } : {}),
	});

let n = 0;
/** Inserts a user and returns a valid session cookie for them. */
export async function signedInUser(
	opts: { adult?: boolean; id?: string } = {},
): Promise<{ id: string; cookie: string }> {
	const id = opts.id ?? `user-${++n}-${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO users (id, google_sub, email, display_name, birthdate_verified_18, home_currency)
		 VALUES (?, ?, ?, ?, ?, 'CAD') ON CONFLICT (id) DO NOTHING`,
	)
		.bind(id, `sub-${id}`, `${id}@example.com`, `User ${n}`, opts.adult === false ? 0 : 1)
		.run();
	const minter = new Hono<AppEnv>();
	minter.get("/", async (c) => {
		await startSession(c, id);
		return c.text("ok");
	});
	const res = await minter.fetch(new Request(API), env, createExecutionContext());
	const setCookie = res.headers.get("Set-Cookie") ?? "";
	return { id, cookie: setCookie.split(";")[0] ?? "" };
}

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

/** Replaces outbound fetch. Any request no route answers fails the test loudly. */
export function mockFetch(...routes: Route[]) {
	const calls: URL[] = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		calls.push(url);
		for (const r of routes) {
			const res = await r(url, init);
			if (res) return res;
		}
		throw new Error(`unmocked fetch: ${url.origin}${url.pathname}`);
	});
	return { calls, spy };
}

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// Tagalong (phase 5) helpers.
// ---------------------------------------------------------------------------

/** Moderator id set in vitest.config.ts (MODERATOR_USER_IDS). */
export const MODERATOR_ID = "00000000-0000-4000-8000-00000000a0d1";

/** Private account fields that must never appear in any Tagalong response. */
export const PRIVATE_HOME = { city: "Privateville", lat: 12.3456789, lng: -98.7654321 };

/** Gives a user a home city and coordinates, so leaks of them can be detected. */
export async function setPrivateHome(userId: string) {
	await env.DB.prepare("UPDATE users SET home_city = ?, home_lat = ?, home_lng = ? WHERE id = ?")
		.bind(PRIVATE_HOME.city, PRIVATE_HOME.lat, PRIVATE_HOME.lng, userId)
		.run();
}

/** Makes an account older than the 7-day new-account window. */
export async function makeOldAccount(userId: string, days = 8) {
	const at = new Date(Date.now() - days * 86400_000).toISOString();
	await env.DB.prepare("UPDATE users SET created_at = ? WHERE id = ?").bind(at, userId).run();
}

/** POST /tagalong/opt-in with a name and city; throws unless it succeeds. */
export async function optIn(
	user: { cookie: string },
	name = "Sam",
	city = "Toronto",
): Promise<void> {
	const res = await postJson("/tagalong/opt-in", { confirm: true, name, city }, user.cookie);
	if (res.status !== 200) throw new Error(`opt-in failed: ${res.status} ${await res.text()}`);
}

export interface TgUser {
	id: string;
	cookie: string;
	name: string;
}

let tgN = 0;
/**
 * A signed-in adult who has opted in to Tagalong. `old` makes the account
 * trusted by age; `ack` acknowledges the safety note. Every user gets a
 * private home city/coords and an email, which leak checks look for.
 */
export async function tagalongUser(
	opts: { old?: boolean; ack?: boolean; city?: string } = {},
): Promise<TgUser> {
	const u = await signedInUser();
	await setPrivateHome(u.id);
	if (opts.old) await makeOldAccount(u.id);
	const name = `Member${++tgN}`;
	await optIn(u, name, opts.city ?? "Toronto");
	if (opts.ack) {
		const res = await postJson("/tagalong/safety-ack", {}, u.cookie);
		if (res.status !== 200) throw new Error(`safety-ack failed: ${res.status}`);
	}
	return { ...u, name };
}

/** Inserts an event row (as a plan run or /events/lookup would) and returns its id. */
export async function makeEvent(name = "Leafs vs Habs"): Promise<string> {
	const id = `evt-${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO events (id, provider, provider_event_id, name, city, country, local_date, starts_at, fetched_at)
		 VALUES (?, 'ticketmaster', ?, ?, 'Toronto', 'CA', '2027-03-01', '2027-03-01T19:00:00Z', ?)`,
	)
		.bind(id, id, name, new Date().toISOString())
		.run();
	return id;
}

/**
 * A plan owned by `userId`. `via: 'plan'` sets plans.event_id; `via: 'package'`
 * leaves it null and attaches the event to one of the plan's packages instead.
 */
export async function makeEventPlan(
	userId: string,
	eventId: string,
	via: "plan" | "package" = "plan",
): Promise<string> {
	const tripId = `trip-${crypto.randomUUID()}`;
	const planId = `plan-${crypto.randomUUID()}`;
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO trip_requests (id, user_id, origin_city, origin_lat, origin_lng, origin_country,
			   event_query, date_from, date_to, party_size, budget_minor, budget_currency, budget_scope, prefs_json)
			 VALUES (?, ?, 'Ottawa', 45.42, -75.69, 'CA', 'Leafs', '2027-03-01', '2027-03-02', 1, 50000, 'CAD', 'total', '{}')`,
		).bind(tripId, userId),
		env.DB.prepare(
			`INSERT INTO plans (id, user_id, trip_request_id, event_id, status, result_json)
			 VALUES (?, ?, ?, ?, 'done', '{}')`,
		).bind(planId, userId, tripId, via === "plan" ? eventId : null),
		...(via === "package"
			? [
					env.DB.prepare(
						`INSERT INTO packages (id, plan_id, rank, label, event_id, total_minor, currency, score, summary_text, details_json)
						 VALUES (?, ?, 1, 'cheapest', ?, 10000, 'CAD', 1, 'Cheapest', '{}')`,
					).bind(`pkg-${crypto.randomUUID()}`, planId, eventId),
				]
			: []),
	]);
	return planId;
}

/** Gives every user a plan for one new event, joins them all, and returns ids. */
export async function groupWith(
	...users: { id: string; cookie: string }[]
): Promise<{ eventId: string; groupId: string }> {
	const eventId = await makeEvent();
	let groupId = "";
	for (const u of users) {
		await makeEventPlan(u.id, eventId);
		const res = await postJson(`/events/${eventId}/group/join`, {}, u.cookie);
		if (res.status !== 200) throw new Error(`join failed: ${res.status} ${await res.text()}`);
		groupId = (await res.json<{ group_id: string }>()).group_id;
	}
	return { eventId, groupId };
}

/** a asks b to connect and b accepts (both must have acked safety and share a group). */
export async function connect(a: TgUser, b: TgUser): Promise<string> {
	const asked = await postJson("/connections", { user_id: b.id }, a.cookie);
	if (asked.status !== 200)
		throw new Error(`connect failed: ${asked.status} ${await asked.text()}`);
	const { connection } = await asked.json<{ connection: { id: string } }>();
	const ok = await postJson(`/connections/${connection.id}/accept`, {}, b.cookie);
	if (ok.status !== 200) throw new Error(`accept failed: ${ok.status} ${await ok.text()}`);
	return connection.id;
}

export interface TestSocket {
	res: Response;
	ws: WebSocket;
	/** Frames received so far: parsed JSON, or the raw string when not JSON. */
	frames: unknown[];
	/** Resolves with the close code once the server closes the socket. */
	closed: Promise<number>;
	/** Resolves once `n` frames have arrived (rejects after `ms`). */
	waitFor(n: number, ms?: number): Promise<unknown[]>;
}

/** Opens the chat socket for a room the way a browser would. Throws unless 101. */
export async function openSocket(path: string, cookie: string): Promise<TestSocket> {
	const res = await call(path, { cookie, headers: { Upgrade: "websocket", Origin: WEB } });
	const ws = res.webSocket;
	if (res.status !== 101 || !ws) throw new Error(`no socket: ${res.status} ${await res.text()}`);
	ws.accept();
	const frames: unknown[] = [];
	const waiters: (() => void)[] = [];
	ws.addEventListener("message", (e) => {
		const raw = String(e.data);
		try {
			frames.push(JSON.parse(raw));
		} catch {
			frames.push(raw); // e.g. the "pong" auto-response
		}
		for (const w of waiters.splice(0)) w();
	});
	const closed = new Promise<number>((resolve) =>
		ws.addEventListener("close", (e) => resolve(e.code)),
	);
	const waitFor = (count: number, ms = 2000) =>
		new Promise<unknown[]>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`waited for ${count} frames, got ${frames.length}`)),
				ms,
			);
			const check = () => {
				if (frames.length >= count) {
					clearTimeout(timer);
					resolve(frames);
				} else waiters.push(check);
			};
			check();
		});
	return { res, ws, frames, closed, waitFor };
}

/** Resolves after `ms`, to let a broadcast that should NOT arrive have its chance. */
export const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/**
 * Walks a JSON value and returns every forbidden key or value found: the keys
 * email, home_city, home_lat, home_lng, and any of the given private values.
 */
export function findPrivate(value: unknown, privateValues: unknown[]): string[] {
	const banned = new Set(["email", "home_city", "home_lat", "home_lng"]);
	const found: string[] = [];
	const walk = (v: unknown, path: string) => {
		if (privateValues.includes(v)) found.push(`${path} = ${String(v)}`);
		if (typeof v === "string")
			for (const p of privateValues)
				if (typeof p === "string" && v.includes(p)) found.push(`${path} contains ${p}`);
		if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
		else if (v && typeof v === "object")
			for (const [k, x] of Object.entries(v)) {
				if (banned.has(k)) found.push(`${path}.${k}`);
				walk(x, `${path}.${k}`);
			}
	};
	walk(value, "$");
	return found;
}

/** Adds a user to an existing group the honest way: a plan for its event, then join. */
export async function joinGroup(u: { id: string; cookie: string }, groupId: string) {
	const row = await env.DB.prepare("SELECT event_id FROM event_groups WHERE id = ?")
		.bind(groupId)
		.first<{ event_id: string }>();
	if (!row) throw new Error(`no group ${groupId}`);
	await makeEventPlan(u.id, row.event_id);
	const res = await postJson(`/events/${row.event_id}/group/join`, {}, u.cookie);
	if (res.status !== 200) throw new Error(`join failed: ${res.status} ${await res.text()}`);
}
