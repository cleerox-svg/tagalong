/**
 * Phase 6 smoke tests: native sign-in (PKCE code exchange), bearer sessions,
 * and the bearer/cookie CSRF split. test-engineer extends these.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { b64url } from "../auth/session.js";
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
async function nativeSignIn(verifier: string, sub = `g-${crypto.randomUUID()}`) {
	const start = await call(
		`/auth/google/start?native=1&code_challenge=${await challengeOf(verifier)}`,
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
		expect(res.status).toBe(302);
		const loc = res.headers.get("Location") ?? "";
		expect(loc.startsWith(`${APP}?code=`)).toBe(true);
		expect(res.headers.getSetCookie().some((h) => h.startsWith("tg_session="))).toBe(false);
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
		const loc = (await nativeSignIn(verifier)).headers.get("Location") ?? "";
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
		const loc = (await nativeSignIn(verifier)).headers.get("Location") ?? "";
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
