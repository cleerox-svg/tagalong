/**
 * Phase 6 smoke tests: native sign-in (PKCE code exchange), bearer sessions,
 * and the bearer/cookie CSRF split. test-engineer extends these.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueNativeCode } from "../auth/native.js";
import { b64url, issueBearer, signToken } from "../auth/session.js";
import {
	call,
	groupWith,
	json,
	mockFetch,
	postJson,
	signedInUser,
	tagalongUser,
	WEB,
} from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APP = "com.averrow.budgetrip://auth/callback";

const idToken = (claims: Record<string, unknown>) => {
	const b64 = (o: unknown) =>
		btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
};

const challengeOf = async (verifier: string) =>
	b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

const newVerifier = () => b64url(crypto.getRandomValues(new Uint8Array(48)));

/** Runs the native start + callback against a mocked Google; returns the app redirect. */
async function nativeSignIn(verifier: string, sub = `g-${crypto.randomUUID()}`, extraQuery = "") {
	const start = await call(
		`/auth/google/start?native=1&code_challenge=${await challengeOf(verifier)}${extraQuery}`,
	);
	expect(start.status).toBe(302);
	const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state");
	const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
	mockFetch((url) =>
		url.hostname === "oauth2.googleapis.com"
			? json({
					id_token: idToken({
						iss: "https://accounts.google.com",
						aud: env.GOOGLE_CLIENT_ID,
						sub,
						exp: Math.floor(Date.now() / 1000) + 600,
						email: `${sub}@example.com`,
						email_verified: true,
					}),
				})
			: undefined,
	);
	const res = await call(`/auth/google/callback?state=${state}&code=abc`, { cookie });
	vi.restoreAllMocks();
	return res;
}

/**
 * The app URL a successful native callback hands back. Since security review M1
 * that is an interstitial page (who signed in, tap to return) whose only link is
 * the fixed app URL, not a silent redirect. Asserts that contract and returns
 * the link (HTML-unescaped).
 */
async function appLink(res: Response): Promise<string> {
	expect(res.status).toBe(200);
	expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
	expect(res.headers.get("Content-Security-Policy") ?? "").toContain("default-src 'none'");
	expect(res.headers.get("Cache-Control")).toBe("no-store");
	expect(res.headers.get("Location")).toBeNull();
	expect(res.headers.getSetCookie().some((h) => h.startsWith("tg_session="))).toBe(false);
	const html = await res.text();
	const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) =>
		(m[1] ?? "").replace(/&amp;/g, "&"),
	);
	expect(hrefs).toHaveLength(1);
	expect(html).not.toMatch(/<script/i);
	const link = hrefs[0] ?? "";
	expect(link).toMatch(/^com\.averrow\.budgetrip:\/\/auth\/callback\?code=[A-Za-z0-9_-]{43}$/);
	return link;
}

const exchange = (code: string, code_verifier: string) =>
	call("/auth/native/exchange", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "capacitor://localhost" },
		body: JSON.stringify({ code, code_verifier }),
	});

describe("native sign-in", () => {
	it("redirects to the fixed app URL with a code, sets no session cookie, and exchanges once", async () => {
		const verifier = newVerifier();
		const res = await nativeSignIn(verifier);
		const loc = await appLink(res);
		expect(loc.startsWith(`${APP}?code=`)).toBe(true);
		const code = new URL(loc.replace(/^[^:]+:/, "https:")).searchParams.get("code") ?? "";

		const ok = await exchange(code, verifier);
		expect(ok.status).toBe(200);
		const body = await ok.json<{ token: string; expires_at: string }>();
		expect(body.token).toMatch(/^b1\./);
		expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now() + 29 * 86400_000);

		const me = await call("/me", { headers: { Authorization: `Bearer ${body.token}` } });
		expect(me.status).toBe(200);

		// Reused code: 400.
		expect((await exchange(code, verifier)).status).toBe(400);
	});

	it("refuses a PKCE mismatch, and the code is burned", async () => {
		const verifier = newVerifier();
		const loc = await appLink(await nativeSignIn(verifier));
		const code = new URL(loc.replace(/^[^:]+:/, "https:")).searchParams.get("code") ?? "";
		expect((await exchange(code, newVerifier())).status).toBe(400);
		expect((await exchange(code, verifier)).status).toBe(400);
	});

	it("rejects a bad challenge at start with an app error redirect", async () => {
		const res = await call("/auth/google/start?native=1&code_challenge=short");
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${APP}?error=bad_request`);
	});
});

describe("bearer sessions", () => {
	it("never falls back to the cookie when an Authorization header is present", async () => {
		const u = await signedInUser();
		const res = await call("/me", { cookie: u.cookie, headers: { Authorization: "Bearer junk" } });
		expect(res.status).toBe(401);
		// A cookie value is not a bearer token.
		const raw = decodeURIComponent(u.cookie.split("=").slice(1).join("="));
		expect((await call("/me", { headers: { Authorization: `Bearer ${raw}` } })).status).toBe(401);
	});

	it("allows a bearer write without an Origin; a cookie write from the native origin is 403", async () => {
		const verifier = newVerifier();
		const loc = await appLink(await nativeSignIn(verifier));
		const code = new URL(loc.replace(/^[^:]+:/, "https:")).searchParams.get("code") ?? "";
		const { token } = await (await exchange(code, verifier)).json<{ token: string }>();

		const bearer = await call("/me/onboarding", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ confirm_18_or_older: true, home_currency: "GBP" }),
		});
		expect(bearer.status).toBe(200);

		const u = await signedInUser({ adult: false });
		const cookieWrite = await postJson(
			"/me/onboarding",
			{ confirm_18_or_older: true, home_currency: "GBP" },
			u.cookie,
			"https://localhost",
		);
		expect(cookieWrite.status).toBe(403);
	});
});

describe("chat tickets", () => {
	const ws = (path: string, origin: string) =>
		call(path, { headers: { Upgrade: "websocket", Origin: origin } });

	it("opens the socket from a native origin with a ticket for that room only", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const other = await groupWith(await tagalongUser());
		const res = await postJson("/chat/ticket", { kind: "group", id: groupId }, a.cookie);
		expect(res.status).toBe(200);
		const { ticket } = await res.json<{ ticket: string }>();
		const q = `?ticket=${encodeURIComponent(ticket)}`;

		const ok = await ws(`/chat/group/${groupId}/ws${q}`, "capacitor://localhost");
		expect(ok.status).toBe(101);
		ok.webSocket?.accept();
		ok.webSocket?.close();
		expect((await ws(`/chat/group/${groupId}/ws${q}`, WEB)).status).toBe(403);
		expect((await ws(`/chat/group/${other.groupId}/ws${q}`, "https://localhost")).status).toBe(401);
		expect((await ws(`/chat/group/${groupId}/ws?ticket=x.y`, "https://localhost")).status).toBe(
			401,
		);
	});

	it("refuses a ticket for a room the user is not in (404, as the socket does)", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(await tagalongUser());
		const res = await postJson("/chat/ticket", { kind: "group", id: groupId }, a.cookie);
		expect(res.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// test-engineer additions (phase 6 gaps).
// ---------------------------------------------------------------------------

const codeOf = (loc: string) =>
	new URL(loc.replace(/^[^:]+:/, "https:")).searchParams.get("code") ?? "";

async function codeRow(userId: string) {
	return env.DB.prepare(
		"SELECT used_at, expires_at FROM native_auth_codes WHERE user_id = ? ORDER BY created_at DESC",
	)
		.bind(userId)
		.all<{ used_at: string | null; expires_at: string }>();
}

describe("native code exchange: edges", () => {
	it("rejects an expired code even with the right verifier", async () => {
		const u = await signedInUser();
		const verifier = newVerifier();
		const code = await issueNativeCode(env.DB, u.id, await challengeOf(verifier));
		await env.DB.prepare("UPDATE native_auth_codes SET expires_at = ? WHERE user_id = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), u.id)
			.run();
		expect((await exchange(code, verifier)).status).toBe(400);
		// An expired code is never marked used (no token issued), and stays unusable.
		expect((await exchange(code, verifier)).status).toBe(400);
	});

	it("accepts a fresh code issued directly (control for the expiry test)", async () => {
		const u = await signedInUser();
		const verifier = newVerifier();
		const code = await issueNativeCode(env.DB, u.id, await challengeOf(verifier));
		const res = await exchange(code, verifier);
		expect(res.status).toBe(200);
		const { token } = await res.json<{ token: string }>();
		const me = await call("/me", { headers: { Authorization: `Bearer ${token}` } });
		expect((await me.json<{ id: string }>()).id).toBe(u.id);
	});

	it("rejects a verifier that belongs to a different challenge, burns that code, leaves the other", async () => {
		const u = await signedInUser();
		const v1 = newVerifier();
		const v2 = newVerifier();
		const c1 = await issueNativeCode(env.DB, u.id, await challengeOf(v1));
		const c2 = await issueNativeCode(env.DB, u.id, await challengeOf(v2));

		// v2 is a genuine verifier, but for c2's challenge, not c1's.
		const wrong = await exchange(c1, v2);
		expect(wrong.status).toBe(400);
		// c1 is burned: its own verifier no longer works.
		expect((await exchange(c1, v1)).status).toBe(400);
		const rows = (await codeRow(u.id)).results;
		expect(rows.filter((r) => r.used_at !== null)).toHaveLength(1);
		// c2 was untouched by the failed attempt.
		expect((await exchange(c2, v2)).status).toBe(200);
	});

	it("answers a failed exchange the same way whatever the reason", async () => {
		const u = await signedInUser();
		const v = newVerifier();
		const code = await issueNativeCode(env.DB, u.id, await challengeOf(v));
		const unknown = await exchange(b64url(crypto.getRandomValues(new Uint8Array(32))), v);
		const mismatch = await exchange(code, newVerifier());
		expect(unknown.status).toBe(400);
		expect(mismatch.status).toBe(400);
		expect(await unknown.text()).toBe(await mismatch.text());
	});

	it("rate-limits the exchange per IP with a 429", async () => {
		const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}-${crypto.randomUUID()}`;
		const attempt = () =>
			call("/auth/native/exchange", {
				method: "POST",
				headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
				body: JSON.stringify({ code: "A".repeat(43), code_verifier: "a".repeat(43) }),
			});
		for (let i = 0; i < 20; i++) expect((await attempt()).status).toBe(400);
		const limited = await attempt();
		expect(limited.status).toBe(429);
		// A valid code from another IP is unaffected.
		const u = await signedInUser();
		const v = newVerifier();
		const code = await issueNativeCode(env.DB, u.id, await challengeOf(v));
		const other = await call("/auth/native/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": `${ip}-other` },
			body: JSON.stringify({ code, code_verifier: v }),
		});
		expect(other.status).toBe(200);
	});
});

describe("native start: no client-chosen redirect", () => {
	const evil = "https://evil.example/steal";
	const extra = [
		`&return_to=${encodeURIComponent(evil)}`,
		`&redirect=${encodeURIComponent(evil)}`,
		`&redirect_uri=${encodeURIComponent(evil)}`,
		`&callback=${encodeURIComponent(evil)}`,
	].join("");

	it("sends Google our own callback and ends on the fixed app URL", async () => {
		const verifier = newVerifier();
		const start = await call(
			`/auth/google/start?native=1&code_challenge=${await challengeOf(verifier)}${extra}`,
		);
		expect(start.status).toBe(302);
		const google = new URL(start.headers.get("Location") ?? "");
		expect(google.hostname).toBe("accounts.google.com");
		expect(google.searchParams.get("redirect_uri")).toBe(
			"https://tagalong-api.averrow.com/auth/google/callback",
		);
		expect(google.href).not.toContain("evil.example");

		const res = await nativeSignIn(verifier, undefined, extra);
		const loc = await appLink(res);
		expect(loc.startsWith(`${APP}?code=`)).toBe(true);
		expect(loc).not.toContain("evil.example");
		expect((await exchange(codeOf(loc), verifier)).status).toBe(200);
	});

	it("a cancelled or bad-state native callback still goes to the app URL, never return_to", async () => {
		const verifier = newVerifier();
		const start = await call(
			`/auth/google/start?native=1&code_challenge=${await challengeOf(verifier)}${extra}`,
		);
		const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state");
		const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
		const cancelled = await call(`/auth/google/callback?state=${state}`, { cookie });
		expect(cancelled.headers.get("Location")).toBe(`${APP}?error=cancelled`);
		const bad = await call(`/auth/google/callback?state=nope&code=abc`, { cookie });
		expect(bad.headers.get("Location")).toBe(`${APP}?error=bad_state`);
		// Lost/expired tg_oauth cookie on a native state: still the app URL, not JSON.
		const lost = await call(`/auth/google/callback?state=${state}&code=abc`);
		expect(lost.status).toBe(302);
		expect(lost.headers.get("Location")).toBe(`${APP}?error=bad_state`);
	});

	it("a bad challenge with a return_to still errors to the app URL", async () => {
		const res = await call(`/auth/google/start?native=1&code_challenge=short${extra}`);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${APP}?error=bad_request`);
	});
});

describe("bearer vs cookie", () => {
	it("a valid bearer for A wins over a valid cookie for B", async () => {
		const a = await signedInUser();
		const b = await signedInUser();
		const { token } = await issueBearer(env, a.id);
		const res = await call("/me", {
			cookie: b.cookie,
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		expect((await res.json<{ id: string }>()).id).toBe(a.id);

		// A write too: the bearer user's prefs change, not the cookie user's.
		const w = await call("/me/notifications", {
			method: "POST",
			cookie: b.cookie,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ dm: false }),
		});
		expect(w.status).toBe(200);
		const aPrefs = await call("/me/notifications", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect((await aPrefs.json<{ dm: boolean }>()).dm).toBe(false);
		const bPrefs = await call("/me/notifications", { cookie: b.cookie });
		expect((await bPrefs.json<{ dm: boolean }>()).dm).toBe(true);
	});

	it("a malformed Authorization on a write without a web Origin is 403, even with a valid cookie", async () => {
		const u = await signedInUser();
		for (const authorization of ["Basic x", "Bearer", "Token abc", ""]) {
			const res = await call("/me/notifications", {
				method: "POST",
				cookie: u.cookie,
				headers: { "Content-Type": "application/json", Authorization: authorization },
				body: JSON.stringify({ dm: false }),
			});
			expect(res.status, JSON.stringify(authorization)).toBe(403);
		}
		const prefs = await call("/me/notifications", { cookie: u.cookie });
		expect((await prefs.json<{ dm: boolean }>()).dm).toBe(true);
	});

	it("a malformed Authorization never falls back to the cookie, even from the web origin", async () => {
		const u = await signedInUser();
		const res = await call("/me/notifications", {
			method: "POST",
			cookie: u.cookie,
			headers: { "Content-Type": "application/json", Authorization: "Basic x", Origin: WEB },
			body: JSON.stringify({ dm: false }),
		});
		expect(res.status).toBe(401);
	});

	it("an expired bearer is refused", async () => {
		const u = await signedInUser();
		const { token } = await issueBearer(env, u.id);
		const real = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(real + 31 * 86400_000);
		expect((await call("/me", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
	});

	it("a bearer token for a deleted account is refused", async () => {
		const { token } = await issueBearer(env, `ghost-${crypto.randomUUID()}`);
		expect((await call("/me", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
	});
});

describe("chat tickets: edges", () => {
	const ws = (path: string, origin?: string) =>
		call(path, { headers: { Upgrade: "websocket", ...(origin ? { Origin: origin } : {}) } });

	async function ticketFor(user: { cookie: string }, kind: "group" | "dm", id: string) {
		const res = await postJson("/chat/ticket", { kind, id }, user.cookie);
		expect(res.status).toBe(200);
		return (await res.json<{ ticket: string; expires_at: string }>()).ticket;
	}

	it("refuses an expired ticket", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const ticket = await ticketFor(a, "group", groupId);
		const real = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(real + 61_000);
		const res = await ws(
			`/chat/group/${groupId}/ws?ticket=${encodeURIComponent(ticket)}`,
			"capacitor://localhost",
		);
		expect(res.status).toBe(401);
	});

	it("refuses a ticket re-labelled for another user (tampered payload)", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		const ticket = await ticketFor(a, "group", groupId);
		const dot = ticket.lastIndexOf(".");
		const payload = JSON.parse(
			atob(ticket.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/")),
		) as { u: string };
		expect(payload.u).toBe(a.id);
		const forged = `${b64url(new TextEncoder().encode(JSON.stringify({ ...payload, u: b.id })))}${ticket.slice(dot)}`;
		const res = await ws(
			`/chat/group/${groupId}/ws?ticket=${encodeURIComponent(forged)}`,
			"capacitor://localhost",
		);
		expect(res.status).toBe(401);
	});

	it("a validly signed ticket for a user outside the room still gets no socket", async () => {
		const a = await tagalongUser();
		const outsider = await tagalongUser();
		const { groupId } = await groupWith(a);
		const e = Math.floor(Date.now() / 1000) + 60;
		const payload = b64url(
			new TextEncoder().encode(JSON.stringify({ u: outsider.id, k: "group", i: groupId, e })),
		);
		const ticket = await signToken(env, "tagalong:chat-ticket:v1", payload);
		const res = await ws(
			`/chat/group/${groupId}/ws?ticket=${encodeURIComponent(ticket)}`,
			"capacitor://localhost",
		);
		expect(res.status).toBe(404);
	});

	it("refuses a bearer token presented as a ticket, and a group ticket on the dm path", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const { token } = await issueBearer(env, a.id);
		expect(
			(
				await ws(
					`/chat/group/${groupId}/ws?ticket=${encodeURIComponent(token)}`,
					"capacitor://localhost",
				)
			).status,
		).toBe(401);
		const ticket = await ticketFor(a, "group", groupId);
		expect(
			(
				await ws(
					`/chat/dm/${groupId}/ws?ticket=${encodeURIComponent(ticket)}`,
					"capacitor://localhost",
				)
			).status,
		).toBe(401);
	});

	it("refuses a ticket used from any web, foreign or missing origin", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const ticket = await ticketFor(a, "group", groupId);
		const q = `?ticket=${encodeURIComponent(ticket)}`;
		for (const origin of [WEB, "http://localhost:5173", "https://evil.example", undefined]) {
			expect((await ws(`/chat/group/${groupId}/ws${q}`, origin)).status, String(origin)).toBe(403);
		}
		// Still valid from the native origin afterwards (the refusals didn't consume it).
		const ok = await ws(`/chat/group/${groupId}/ws${q}`, "https://localhost");
		expect(ok.status).toBe(101);
		ok.webSocket?.accept();
		ok.webSocket?.close();
	});

	it("mints a ticket with a bearer from the native app; a cookie from the native origin is 403", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const { token } = await issueBearer(env, a.id);
		const res = await call("/chat/ticket", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				Origin: "capacitor://localhost",
			},
			body: JSON.stringify({ kind: "group", id: groupId }),
		});
		expect(res.status).toBe(200);
		expect(
			(
				await postJson(
					"/chat/ticket",
					{ kind: "group", id: groupId },
					a.cookie,
					"capacitor://localhost",
				)
			).status,
		).toBe(403);
	});
});
