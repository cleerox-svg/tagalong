/**
 * Phase 7 review fixes (backend): suspension survives delete + re-sign-up,
 * Apple email_verified, per-IP sign-in limits, writes racing a deletion, the
 * native error interstitial, the cron's per-trip isolation, and deletion
 * coverage gaps.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueNativeCode } from "../auth/native.js";
import { issueBearer } from "../auth/session.js";
import { identityHash } from "../auth/suspended-identity.js";
import app from "../index.js";
import { checkSavedTrips } from "../planning/alerts.js";
import {
	makeAppleKit,
	mockApple,
	pkcePair,
	postAppleCallback,
	startApple,
	uniqueSub,
	type AppleKit,
} from "./apple-fixtures.js";
import {
	API,
	call,
	json,
	makeEvent,
	makeEventPlan,
	mockFetch,
	postJson,
	signedInUser,
	WEB,
} from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APP_CALLBACK = "https://tagalong.averrow.com/auth/app-callback";
const SUSPENDED_AT = "2026-10-01T12:00:00.000Z";

const count = async (sql: string, ...binds: unknown[]) =>
	(
		await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
			.bind(...binds)
			.first<{ n: number }>()
	)?.n ?? -1;

const sessionOf = (res: Response) =>
	res.headers
		.getSetCookie()
		.find((h) => h.startsWith("tg_session="))
		?.split(";")[0] ?? "";

// ---------------------------------------------------------------------------
// Google sign-in (mocked token endpoint).
// ---------------------------------------------------------------------------

const googleIdToken = (sub: string, email: string) => {
	const b64 = (o: unknown) =>
		btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${b64({ alg: "RS256" })}.${b64({
		iss: "https://accounts.google.com",
		aud: env.GOOGLE_CLIENT_ID,
		sub,
		exp: Math.floor(Date.now() / 1000) + 600,
		email,
		email_verified: true,
		name: "Gee",
	})}.sig`;
};

/** A full web Google sign-in for `sub`; returns the new session cookie. */
async function googleSignIn(sub: string): Promise<string> {
	const start = await call("/auth/google/start");
	const loc = new URL(start.headers.get("Location") ?? "");
	const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
	mockFetch((url) =>
		url.hostname === "oauth2.googleapis.com"
			? json({ id_token: googleIdToken(sub, `${sub}@example.com`) })
			: undefined,
	);
	const res = await call(`/auth/google/callback?state=${loc.searchParams.get("state")}&code=abc`, {
		cookie,
	});
	vi.restoreAllMocks();
	expect(res.status).toBe(302);
	const session = sessionOf(res);
	expect(session).toMatch(/^tg_session=/);
	return session;
}

/** A full web Apple sign-in for `sub`; returns the new session cookie. */
async function appleSignIn(
	kit: AppleKit,
	sub: string,
	claims: Record<string, unknown> = {},
): Promise<string> {
	const started = await startApple(kit.appleEnv);
	mockApple(kit, { sub, claims }, () => started.nonce);
	const res = await postAppleCallback(
		kit.appleEnv,
		{ state: started.state, code: "c" },
		started.cookie,
	);
	vi.restoreAllMocks();
	expect(res.status).toBe(303);
	const session = sessionOf(res);
	expect(session).toMatch(/^tg_session=/);
	return session;
}

const meId = async (cookie: string) =>
	(await (await call("/me", { cookie })).json<{ id: string }>()).id;

async function onboard(cookie: string) {
	const res = await postJson(
		"/me/onboarding",
		{ confirm_18_or_older: true, home_currency: "CAD" },
		cookie,
	);
	expect(res.status).toBe(200);
}

const deleteAccount = async (cookie: string) => {
	const res = await postJson("/me/delete", { confirm: "DELETE" }, cookie);
	expect(res.status).toBe(200);
};

const suspendedAt = async (id: string) =>
	(
		await env.DB.prepare("SELECT tagalong_suspended_at AS s FROM users WHERE id = ?")
			.bind(id)
			.first<{ s: string | null }>()
	)?.s;

// ---------------------------------------------------------------------------

describe("a Tagalong suspension survives deleting the account and signing up again", () => {
	it("Google: the new account starts suspended and can't opt in", async () => {
		const sub = `g${Date.now()}${Math.floor(Math.random() * 1e6)}`;
		const first = await googleSignIn(sub);
		const oldId = await meId(first);
		await env.DB.prepare("UPDATE users SET tagalong_suspended_at = ? WHERE id = ?")
			.bind(SUSPENDED_AT, oldId)
			.run();
		await deleteAccount(first);

		const hash = await identityHash(env, "google", sub);
		expect(
			await env.DB.prepare("SELECT suspended_at FROM suspended_identities WHERE id_hash = ?")
				.bind(hash)
				.first(),
		).toEqual({ suspended_at: SUSPENDED_AT });

		const second = await googleSignIn(sub);
		const newId = await meId(second);
		expect(newId).not.toBe(oldId);
		expect(await suspendedAt(newId)).toBe(SUSPENDED_AT);
		const me = await (await call("/me", { cookie: second })).json<any>();
		expect(me.tagalong.suspended).toBe(true);

		await onboard(second);
		const optIn = await postJson(
			"/tagalong/opt-in",
			{ confirm: true, name: "Sam", city: "Toronto" },
			second,
		);
		expect(optIn.status).toBe(403);
		expect((await optIn.json<any>()).error.code).toBe("tagalong_suspended");

		// Signing in again does not re-apply anything to an existing account
		// (a moderator could have lifted it): only a NEW row inherits it.
		await env.DB.prepare("UPDATE users SET tagalong_suspended_at = NULL WHERE id = ?")
			.bind(newId)
			.run();
		const third = await googleSignIn(sub);
		expect(await meId(third)).toBe(newId);
		expect(await suspendedAt(newId)).toBeNull();
	});

	it("Apple: the new account starts suspended and can't opt in; no raw sub is stored", async () => {
		const kit = await makeAppleKit();
		const sub = uniqueSub("susp");
		const first = await appleSignIn(kit, sub);
		const oldId = await meId(first);
		await env.DB.prepare("UPDATE users SET tagalong_suspended_at = ? WHERE id = ?")
			.bind(SUSPENDED_AT, oldId)
			.run();
		await deleteAccount(first);

		const hash = await identityHash(env, "apple", sub);
		expect(await count("suspended_identities WHERE id_hash = ?", hash)).toBe(1);
		// Only the Apple identity: an Apple-only account's google_sub is a sentinel.
		expect(
			await count(
				"suspended_identities WHERE id_hash = ?",
				await identityHash(env, "google", `apple:${sub}`),
			),
		).toBe(0);

		// Nothing in the table is or contains the raw sub (or the user id).
		const { results } = await env.DB.prepare("SELECT * FROM suspended_identities").all();
		const dump = JSON.stringify(results);
		expect(dump).not.toContain(sub);
		expect(dump).not.toContain(oldId);
		for (const r of results as { id_hash: string }[])
			expect(r.id_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const second = await appleSignIn(kit, sub);
		const newId = await meId(second);
		expect(newId).not.toBe(oldId);
		expect(await suspendedAt(newId)).toBe(SUSPENDED_AT);
		await onboard(second);
		const optIn = await postJson(
			"/tagalong/opt-in",
			{ confirm: true, name: "Sam", city: "Toronto" },
			second,
		);
		expect(optIn.status).toBe(403);
		expect((await optIn.json<any>()).error.code).toBe("tagalong_suspended");
	});

	it("a non-suspended account's deletion stores nothing, and its new account is not suspended", async () => {
		const kit = await makeAppleKit();
		const sub = uniqueSub("free");
		const gsub = `g${Date.now()}${Math.floor(Math.random() * 1e6)}`;
		const before = await count("suspended_identities");

		const apple = await appleSignIn(kit, sub);
		await deleteAccount(apple);
		const google = await googleSignIn(gsub);
		await deleteAccount(google);

		expect(await count("suspended_identities")).toBe(before);
		expect(
			await count("suspended_identities WHERE id_hash = ?", await identityHash(env, "apple", sub)),
		).toBe(0);
		const again = await appleSignIn(kit, sub);
		expect(await suspendedAt(await meId(again))).toBeNull();
	});
});

describe("Apple email_verified", () => {
	it.each([
		["missing", { email_verified: undefined }],
		["false", { email_verified: false }],
		['"false"', { email_verified: "false" }],
	])("%s: the email is not stored", async (_label, claims) => {
		const kit = await makeAppleKit();
		const sub = uniqueSub("ev");
		const session = await appleSignIn(kit, sub, claims);
		const row = await env.DB.prepare("SELECT email FROM users WHERE apple_sub = ?")
			.bind(sub)
			.first<{ email: string }>();
		expect(row?.email).toBe("");
		expect((await (await call("/me", { cookie: session })).json<any>()).email).toBe("");
	});

	it.each([
		["true", true],
		['"true"', "true"],
	])("%s: the email is stored", async (_label, v) => {
		const kit = await makeAppleKit();
		const sub = uniqueSub("ev");
		await appleSignIn(kit, sub, { email_verified: v });
		const row = await env.DB.prepare("SELECT email FROM users WHERE apple_sub = ?")
			.bind(sub)
			.first<{ email: string }>();
		expect(row?.email).toBe(`${sub}@privaterelay.appleid.com`);
	});
});

// ---------------------------------------------------------------------------
// Native error interstitial.
// ---------------------------------------------------------------------------

async function expectErrorPage(res: Response, code: string, reason: string) {
	expect(res.status).toBe(200);
	expect(res.headers.get("Location")).toBeNull();
	expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
	expect(res.headers.get("Content-Security-Policy")).toBe(
		"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	);
	expect(res.headers.get("Cache-Control")).toBe("no-store");
	expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
	expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(res.headers.getSetCookie().some((h) => h.startsWith("tg_session="))).toBe(false);
	const html = await res.text();
	expect(html).toContain(`Sign-in didn't finish — ${reason}. Return to Budgetrip and try again.`);
	const links = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
	expect(links).toEqual([`${APP_CALLBACK}?error=${code}`]);
	expect(html).toContain(">Return to Budgetrip</a>");
	expect(html).toContain("background:#0f766e");
	expect(html).toContain(
		"If the app doesn't open, make sure Budgetrip is installed, then try again from the app.",
	);
	expect(html).not.toMatch(/<script/i);
	return html;
}

describe("native sign-in errors show the interstitial", () => {
	it("Google start with a bad challenge", async () => {
		const res = await call("/auth/google/start?native=1&code_challenge=short");
		await expectErrorPage(res, "bad_request", "the app&#39;s request was incomplete");
	});

	it("Google callback whose native cookie was lost", async () => {
		const res = await call(`/auth/google/callback?state=n.${crypto.randomUUID()}&code=x`);
		await expectErrorPage(res, "bad_state", "the sign-in expired or was started elsewhere");
	});

	it("Google native cancel", async () => {
		const { challenge } = await pkcePair();
		const start = await call(`/auth/google/start?native=1&code_challenge=${challenge}`);
		const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
		const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state");
		const res = await call(`/auth/google/callback?state=${state}&error=access_denied`, {
			cookie,
		});
		await expectErrorPage(res, "cancelled", "it was cancelled");
	});

	it("Apple start when Apple isn't configured", async () => {
		const { challenge } = await pkcePair();
		const res = await call(`/auth/apple/start?native=1&code_challenge=${challenge}`);
		await expectErrorPage(res, "misconfigured", "this sign-in option isn&#39;t set up yet");
	});

	it("Apple native callback with a lost cookie", async () => {
		const kit = await makeAppleKit();
		const res = await postAppleCallback(
			kit.appleEnv,
			{ state: `n.${crypto.randomUUID()}`, code: "c" },
			"",
		);
		await expectErrorPage(res, "bad_state", "the sign-in expired or was started elsewhere");
	});

	it("an error during the native exchange (Apple token endpoint down)", async () => {
		const kit = await makeAppleKit();
		const { challenge } = await pkcePair();
		const started = await startApple(kit.appleEnv, `?native=1&code_challenge=${challenge}`);
		mockFetch(() => new Response("down", { status: 503 }));
		const res = await postAppleCallback(
			kit.appleEnv,
			{ state: started.state, code: "c" },
			started.cookie,
		);
		await expectErrorPage(res, "apple_token_failed", "something went wrong");
		expect(await count("native_auth_codes WHERE code_challenge = ?", challenge)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Per-IP sign-in rate limits.
// ---------------------------------------------------------------------------

let ipN = 0;
const freshIp = () => `198.51.100.${++ipN}`;

describe("sign-in endpoints are rate limited per IP (20/min)", () => {
	it("Google start: web 429 on the 21st; another IP is unaffected", async () => {
		const ip = freshIp();
		for (let i = 0; i < 20; i++) {
			const res = await call("/auth/google/start", { headers: { "CF-Connecting-IP": ip } });
			expect(res.status).toBe(302);
		}
		const limited = await call("/auth/google/start", { headers: { "CF-Connecting-IP": ip } });
		expect(limited.status).toBe(429);
		expect((await limited.json<any>()).error.code).toBe("rate_limited");
		expect(limited.headers.get("Set-Cookie")).toBeNull();
		const other = await call("/auth/google/start", {
			headers: { "CF-Connecting-IP": freshIp() },
		});
		expect(other.status).toBe(302);
	});

	it("Google start, native: the 21st shows the rate_limited interstitial", async () => {
		const ip = freshIp();
		const { challenge } = await pkcePair();
		const path = `/auth/google/start?native=1&code_challenge=${challenge}`;
		for (let i = 0; i < 20; i++)
			expect((await call(path, { headers: { "CF-Connecting-IP": ip } })).status).toBe(302);
		const res = await call(path, { headers: { "CF-Connecting-IP": ip } });
		await expectErrorPage(res, "rate_limited", "there were too many attempts, so wait a minute");
	});

	it("Google callback: 429 after 20 (web), interstitial for a native state", async () => {
		const ip = freshIp();
		for (let i = 0; i < 20; i++) {
			const res = await call("/auth/google/callback?state=x&code=y", {
				headers: { "CF-Connecting-IP": ip },
			});
			expect(res.status).toBe(400);
		}
		const web = await call("/auth/google/callback?state=x&code=y", {
			headers: { "CF-Connecting-IP": ip },
		});
		expect(web.status).toBe(429);
		const native = await call(`/auth/google/callback?state=n.${crypto.randomUUID()}&code=y`, {
			headers: { "CF-Connecting-IP": ip },
		});
		await expectErrorPage(native, "rate_limited", "there were too many attempts, so wait a minute");
	});

	it("Apple start and callback", async () => {
		const kit = await makeAppleKit();
		const ip = freshIp();
		const hdr = { "CF-Connecting-IP": ip };
		const call2 = async (path: string, init: RequestInit = {}) => {
			const ctx = createExecutionContext();
			const res = await app.fetch(new Request(`${API}${path}`, init), kit.appleEnv, ctx);
			await waitOnExecutionContext(ctx);
			return res;
		};
		for (let i = 0; i < 20; i++)
			expect((await call2("/auth/apple/start", { headers: hdr })).status).toBe(302);
		expect((await call2("/auth/apple/start", { headers: hdr })).status).toBe(429);
		const { challenge } = await pkcePair();
		await expectErrorPage(
			await call2(`/auth/apple/start?native=1&code_challenge=${challenge}`, { headers: hdr }),
			"rate_limited",
			"there were too many attempts, so wait a minute",
		);

		for (let i = 0; i < 20; i++) {
			const res = await postAppleCallback(kit.appleEnv, { state: "x", code: "c" }, "", hdr);
			expect(res.status).toBe(400);
		}
		expect((await postAppleCallback(kit.appleEnv, { state: "x", code: "c" }, "", hdr)).status).toBe(
			429,
		);
		await expectErrorPage(
			await postAppleCallback(
				kit.appleEnv,
				{ state: `n.${crypto.randomUUID()}`, code: "c" },
				"",
				hdr,
			),
			"rate_limited",
			"there were too many attempts, so wait a minute",
		);
	});
});

// ---------------------------------------------------------------------------
// Writes that race an account deletion.
// ---------------------------------------------------------------------------

/**
 * An env whose DB runs the user's real account deletion (POST /me/delete) the
 * first time a batch is sent: i.e. after the request authenticated, just
 * before its write.
 */
function envDeletingBeforeBatch(cookie: string): Env {
	let armed = true;
	const db = new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "batch")
				return async (stmts: D1PreparedStatement[]) => {
					if (armed) {
						armed = false;
						const res = await postJson("/me/delete", { confirm: "DELETE" }, cookie);
						expect(res.status).toBe(200);
					}
					return target.batch(stmts);
				};
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	return { ...env, DB: db } as Env;
}

async function callAs(e: Env, path: string, bearer: string, body: unknown) {
	const ctx = createExecutionContext();
	const res = await app.fetch(
		new Request(`${API}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
			body: JSON.stringify(body),
		}),
		e,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

const tripBody = {
	origin: { label: "Toronto, ON, Canada", lat: 43.6532, lng: -79.3832, country_code: "CA" },
	event: { query: "Leafs at Bruins" },
	date_from: "2027-06-01",
	date_to: "2027-06-02",
	party_size: 1,
	budget: { amount_minor: 100000, currency: "CAD", scope: "total" },
	prefs: {
		transport: "any",
		stay: "any",
		max_nights: 1,
		seat_quality: "any",
		vibe_tags: [],
	},
};

describe("writes after authentication are refused once the account is deleted", () => {
	it("registering a push device with a captured bearer: 401, no row", async () => {
		const u = await signedInUser();
		const bearer = (await issueBearer(env, u.id)).token;
		const token = `tok-${crypto.randomUUID()}`;
		const res = await callAs(envDeletingBeforeBatch(u.cookie), "/push/devices", bearer, {
			platform: "android",
			token,
		});
		expect(res.status).toBe(401);
		expect(await count("push_devices WHERE token = ?", token)).toBe(0);
		expect(await count("push_devices WHERE user_id = ?", u.id)).toBe(0);
	});

	it("creating a trip with a captured bearer: 401, no trip request or plan", async () => {
		const u = await signedInUser();
		const bearer = (await issueBearer(env, u.id)).token;
		const res = await callAs(envDeletingBeforeBatch(u.cookie), "/plans", bearer, tripBody);
		expect(res.status).toBe(401);
		expect(await count("trip_requests WHERE user_id = ?", u.id)).toBe(0);
		expect(await count("plans WHERE user_id = ?", u.id)).toBe(0);
	});

	it("without a race the same requests still work", async () => {
		const u = await signedInUser();
		const bearer = (await issueBearer(env, u.id)).token;
		const token = `tok-${crypto.randomUUID()}`;
		expect((await callAs(env, "/push/devices", bearer, { platform: "ios", token })).status).toBe(
			204,
		);
		expect(await count("push_devices WHERE token = ? AND user_id = ?", token, u.id)).toBe(1);
		const prefs = await callAs(env, "/me/notifications", bearer, { dm: false });
		expect(prefs.status).toBe(200);
		expect((await prefs.json<any>()).dm).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Cron: one failing trip doesn't stop the run.
// ---------------------------------------------------------------------------

async function savedTrip(userId: string) {
	const planId = await makeEventPlan(userId, await makeEvent());
	const trip = await env.DB.prepare("SELECT trip_request_id AS t FROM plans WHERE id = ?")
		.bind(planId)
		.first<{ t: string }>();
	await env.DB.prepare(
		`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, best_total_minor, currency)
		 VALUES (?, ?, ?, ?, 10000, 'CAD')`,
	)
		.bind(userId, planId, trip?.t, planId)
		.run();
	return planId;
}

describe("checkSavedTrips", () => {
	it("keeps going after one trip fails, and logs no personal data", async () => {
		// Any trip left due by earlier tests is checked off first.
		await env.DB.prepare("UPDATE saved_trips SET last_checked_at = ?")
			.bind(new Date().toISOString())
			.run();
		const a = await signedInUser();
		const b = await signedInUser();
		const planA = await savedTrip(a.id);
		const planB = await savedTrip(b.id);

		let failed = false;
		const db = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare")
					return (sql: string) => {
						if (!failed && sql.includes("INSERT INTO plans")) {
							failed = true;
							return {
								bind: () => ({
									run: () => Promise.reject(new Error("D1_ERROR: FOREIGN KEY constraint failed")),
								}),
							};
						}
						return target.prepare(sql);
					};
				const v = Reflect.get(target, prop);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		// Every provider is down: the surviving trip's run just finishes without prices.
		mockFetch(() => new Response("down", { status: 503 }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const r = await checkSavedTrips({ ...env, DB: db } as Env);
		expect(r.checked).toBe(2);
		expect(failed).toBe(true);
		const rechecks = await count("plans WHERE rechecked_from IN (?, ?)", planA, planB);
		expect(rechecks).toBe(1); // the trip after the failure still ran

		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).toContain("price check failed for a saved trip");
		for (const s of [a.id, b.id, `${a.id}@example.com`, `${b.id}@example.com`])
			expect(logged).not.toContain(s);
	});

	it("skips a trip whose owner is deleted", async () => {
		await env.DB.prepare("UPDATE saved_trips SET last_checked_at = ?")
			.bind(new Date().toISOString())
			.run();
		const u = await signedInUser();
		const planId = await savedTrip(u.id);
		await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), u.id)
			.run();
		mockFetch(() => new Response("down", { status: 503 }));
		const r = await checkSavedTrips(env);
		expect(r.checked).toBe(0);
		expect(await count("plans WHERE rechecked_from = ?", planId)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Deletion coverage gaps.
// ---------------------------------------------------------------------------

describe("account deletion removes alerts, re-check chains and app sign-in codes", () => {
	it("leaves no rows behind and no broken foreign keys", async () => {
		const u = await signedInUser();
		const planA = await savedTrip(u.id);
		const trip = (await env.DB.prepare("SELECT trip_request_id AS t FROM plans WHERE id = ?")
			.bind(planA)
			.first<{ t: string }>())!.t;
		// A re-check chain A <- B <- C, the saved trip following C, and an alert on B.
		const planB = `plan-${crypto.randomUUID()}`;
		const planC = `plan-${crypto.randomUUID()}`;
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO plans (id, user_id, trip_request_id, status, rechecked_from)
				 VALUES (?, ?, ?, 'done', ?)`,
			).bind(planB, u.id, trip, planA),
			env.DB.prepare(
				`INSERT INTO plans (id, user_id, trip_request_id, status, rechecked_from)
				 VALUES (?, ?, ?, 'done', ?)`,
			).bind(planC, u.id, trip, planB),
			env.DB.prepare("UPDATE saved_trips SET latest_plan_id = ? WHERE user_id = ?").bind(
				planC,
				u.id,
			),
			env.DB.prepare(
				`INSERT INTO price_alerts (id, user_id, trip_request_id, plan_id, old_total_minor, new_total_minor, currency)
				 VALUES (?, ?, ?, ?, 10000, 9000, 'CAD')`,
			).bind(`alert-${crypto.randomUUID()}`, u.id, trip, planB),
		]);
		const { challenge } = await pkcePair();
		await issueNativeCode(env.DB, u.id, challenge);
		await issueNativeCode(env.DB, u.id, challenge);
		expect(await count("native_auth_codes WHERE user_id = ?", u.id)).toBe(2);

		const res = await postJson("/me/delete", { confirm: "DELETE" }, u.cookie, WEB);
		expect(res.status).toBe(200);

		expect(await count("price_alerts WHERE user_id = ?", u.id)).toBe(0);
		expect(await count("plans WHERE user_id = ?", u.id)).toBe(0);
		expect(await count("plans WHERE id IN (?, ?, ?)", planA, planB, planC)).toBe(0);
		expect(await count("saved_trips WHERE user_id = ?", u.id)).toBe(0);
		expect(await count("trip_requests WHERE user_id = ?", u.id)).toBe(0);
		expect(await count("native_auth_codes WHERE user_id = ?", u.id)).toBe(0);
		const fk = await env.DB.prepare("PRAGMA foreign_key_check").all();
		expect(fk.results).toEqual([]);
	});
});
