import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API, call, json, mockFetch, postJson, signedInUser, WEB } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const idToken = (claims: Record<string, unknown>) => {
	const b64 = (o: unknown) =>
		btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
};

async function startOAuth(returnTo?: string) {
	const res = await call(
		`/auth/google/start${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`,
	);
	const location = new URL(res.headers.get("Location") ?? "");
	const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
	return { res, location, cookie, state: location.searchParams.get("state") ?? "" };
}

describe("Google sign-in", () => {
	it("redirects to Google with our client id, callback and a state", async () => {
		const { res, location, cookie, state } = await startOAuth();
		expect(res.status).toBe(302);
		expect(location.origin).toBe("https://accounts.google.com");
		expect(location.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
		expect(location.searchParams.get("redirect_uri")).toBe(`${API}/auth/google/callback`);
		expect(state).toMatch(/[0-9a-f-]{36}/);
		expect(cookie).toMatch(/^tg_oauth=/);
	});

	it("creates the user and an HttpOnly session, then returns to the web app", async () => {
		const { cookie, state } = await startOAuth(`${WEB}/plans/x`);
		mockFetch((url) =>
			url.hostname === "oauth2.googleapis.com"
				? json({
						id_token: idToken({
							iss: "https://accounts.google.com",
							aud: env.GOOGLE_CLIENT_ID,
							sub: "google-123",
							exp: Math.floor(Date.now() / 1000) + 600,
							email: "ada@example.com",
							email_verified: true,
							name: "Ada",
						}),
					})
				: undefined,
		);
		const res = await call(`/auth/google/callback?state=${state}&code=abc`, { cookie });
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${WEB}/plans/x`);
		const session = res.headers.getSetCookie().find((h) => h.startsWith("tg_session="));
		expect(session).toMatch(/HttpOnly/i);
		expect(session).toMatch(/Secure/i);
		expect(session).toMatch(/SameSite=Lax/i);

		const me = await call("/me", { cookie: session?.split(";")[0] ?? "" });
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({
			email: "ada@example.com",
			display_name: "Ada",
			birthdate_verified_18: false,
		});
	});

	it("rejects a callback whose state does not match", async () => {
		const { cookie } = await startOAuth();
		const res = await call("/auth/google/callback?state=forged&code=abc", { cookie });
		expect(res.status).toBe(400);
	});

	it("rejects a token issued for another client", async () => {
		const { cookie, state } = await startOAuth();
		mockFetch(() =>
			json({
				id_token: idToken({
					iss: "accounts.google.com",
					aud: "someone-else",
					sub: "x",
					exp: Math.floor(Date.now() / 1000) + 600,
					email: "x@example.com",
					email_verified: true,
				}),
			}),
		);
		const res = await call(`/auth/google/callback?state=${state}&code=abc`, { cookie });
		expect(res.status).toBe(401);
	});

	it("never redirects off our own origins after sign-in", async () => {
		const { location } = await startOAuth("https://evil.example/steal");
		expect(location.searchParams.get("state")).toBeTruthy();
		// The return target is stored in the signed cookie; check it via a cancelled callback.
		const { cookie, state } = await startOAuth("https://evil.example/steal");
		const res = await call(`/auth/google/callback?state=${state}`, { cookie });
		expect(res.headers.get("Location")).toBe(`${WEB}/`);
	});
});

describe("sessions", () => {
	it("401s without a cookie and with a tampered one", async () => {
		expect((await call("/me")).status).toBe(401);
		const { cookie } = await signedInUser();
		const tampered = cookie.replace(/user-/, "usex-");
		expect((await call("/me", { cookie: tampered })).status).toBe(401);
	});
});

describe("onboarding", () => {
	it("records the 18+ confirmation and home currency", async () => {
		const u = await signedInUser({ adult: false });
		const res = await postJson(
			"/me/onboarding",
			{ confirm_18_or_older: true, home_currency: "GBP" },
			u.cookie,
		);
		expect(res.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT birthdate_verified_18, home_currency, age_confirmed_at FROM users WHERE id = ?",
		)
			.bind(u.id)
			.first<{ birthdate_verified_18: number; home_currency: string; age_confirmed_at: string }>();
		expect(row).toMatchObject({ birthdate_verified_18: 1, home_currency: "GBP" });
		expect(row?.age_confirmed_at).toBeTruthy();
	});

	it("refuses without the confirmation", async () => {
		const u = await signedInUser({ adult: false });
		const res = await postJson(
			"/me/onboarding",
			{ confirm_18_or_older: false, home_currency: "GBP" },
			u.cookie,
		);
		expect(res.status).toBe(400);
	});
});

describe("CORS and CSRF", () => {
	it("allows only the listed origins, with credentials", async () => {
		const ok = await call("/health", { headers: { Origin: WEB } });
		expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
		expect(ok.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		const bad = await call("/health", { headers: { Origin: "https://evil.example" } });
		expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("refuses a cookie-authenticated write from another origin", async () => {
		const u = await signedInUser({ adult: false });
		const res = await postJson(
			"/me/onboarding",
			{ confirm_18_or_older: true, home_currency: "GBP" },
			u.cookie,
			"https://evil.example",
		);
		expect(res.status).toBe(403);
	});

	it("refuses a non-JSON write", async () => {
		const u = await signedInUser();
		const res = await call("/plans", {
			method: "POST",
			headers: { Origin: WEB, "Content-Type": "application/x-www-form-urlencoded" },
			body: "a=b",
			cookie: u.cookie,
		});
		expect(res.status).toBe(415);
	});
});
