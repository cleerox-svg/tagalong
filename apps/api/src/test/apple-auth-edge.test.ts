/**
 * Phase 7: Sign in with Apple, the edges. Start parameters and cookie
 * attributes, fail-closed configuration, return_to, the callback's state
 * handling, every id_token check, first-sign-in `user` handling, account
 * mapping (no email linking), the encrypted refresh token, the ES256 client
 * secret and the native PKCE path.
 *
 * Apple is mocked (./apple-fixtures.ts); nothing reaches the network.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	decryptRefreshToken,
	encryptRefreshToken,
	verifyAppleIdToken,
} from "../auth/apple.js";
import { b64url } from "../auth/session.js";
import {
	APP_CALLBACK,
	assertClientSecret,
	b64json,
	callWith,
	claimsFor,
	cookieOf,
	decodeJson,
	ISS,
	makeAppleKit,
	mockApple,
	newRsa,
	nowS,
	pkcePair,
	postAppleCallback,
	SERVICES_ID,
	setCookieOf,
	signJwt,
	startApple,
	uniqueSub,
	type AppleKit,
	type AppleReply,
} from "./apple-fixtures.js";
import { API, call, mockFetch, signedInUser, WEB } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

let kit: AppleKit;
beforeAll(async () => {
	kit = await makeAppleKit();
});

const enc = new TextEncoder();
const KEYS_URL = `${ISS}/auth/keys`;

/** Puts a JWKS in caches.default as if fetched earlier (to test the refetch). */
async function primeJwksCache(body: unknown) {
	await caches.default.put(
		new Request(KEYS_URL),
		new Response(JSON.stringify(body), {
			headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
		}),
	);
}

const userRow = (sub: string) =>
	env.DB.prepare(
		"SELECT id, google_sub, apple_sub, email, display_name, apple_refresh_token_enc FROM users WHERE apple_sub = ?",
	)
		.bind(sub)
		.first<{
			id: string;
			google_sub: string;
			apple_sub: string;
			email: string;
			display_name: string;
			apple_refresh_token_enc: string | null;
		}>();

const countUsers = async (sub: string) =>
	(
		await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE apple_sub = ?")
			.bind(sub)
			.first<{ n: number }>()
	)?.n ?? -1;

const countCodes = async () =>
	(await env.DB.prepare("SELECT COUNT(*) AS n FROM native_auth_codes").first<{ n: number }>())?.n ??
	-1;

/** One full web sign-in. */
async function webSignIn(
	reply: AppleReply,
	opts: { user?: string; returnTo?: string; fields?: Record<string, string> } = {},
) {
	const s = await startApple(
		kit.appleEnv,
		opts.returnTo ? `?return_to=${encodeURIComponent(opts.returnTo)}` : "",
	);
	const apple = mockApple(kit, reply, () => s.nonce);
	const res = await postAppleCallback(
		kit.appleEnv,
		{
			state: s.state,
			code: `code-${crypto.randomUUID()}`,
			...(opts.user !== undefined ? { user: opts.user } : {}),
			...opts.fields,
		},
		s.cookie,
	);
	vi.restoreAllMocks();
	return { res, started: s, apple, session: cookieOf(res, "tg_session") };
}

const me = async (session: string) => {
	const res = await call("/me", { cookie: session });
	expect(res.status).toBe(200);
	return res.json<{
		id: string;
		email: string;
		display_name: string;
		sign_in_providers: string[];
	}>();
};

function expectAppleCookieAttrs(setCookie: string) {
	expect(setCookie).toMatch(/;\s*HttpOnly/i);
	expect(setCookie).toMatch(/;\s*Secure/i);
	expect(setCookie).toMatch(/;\s*SameSite=None/i);
	expect(setCookie).toMatch(/;\s*Path=\/auth\/apple(;|$)/);
}

// ---------------------------------------------------------------------------
// Start.
// ---------------------------------------------------------------------------

describe("Apple start: parameters and cookie", () => {
	it("web: state and nonce are fresh per start, distinct, and the cookie is SameSite=None; Secure; HttpOnly; Path=/auth/apple; Max-Age=600", async () => {
		const a = await startApple(kit.appleEnv);
		const b = await startApple(kit.appleEnv);
		expect(a.state).not.toBe(b.state);
		expect(a.nonce).not.toBe(b.nonce);
		expect(a.state).not.toBe(a.nonce);
		expect(a.state.startsWith("n.")).toBe(false);
		const set = setCookieOf(a.res, "tg_oauth_apple");
		expectAppleCookieAttrs(set);
		expect(set).toMatch(/;\s*Max-Age=600(;|$)/);
		// Google's state cookie is not touched by an Apple start.
		expect(setCookieOf(a.res, "tg_oauth")).toBe("");
		expect(cookieOf(a.res, "tg_session")).toBe("");
		expect(a.loc.searchParams.get("scope")).toBe("name email");
		expect(a.loc.searchParams.get("response_mode")).toBe("form_post");
	});

	it("native: same cookie attributes, an n.-prefixed state, and the PKCE challenge never goes to Apple", async () => {
		const { challenge } = await pkcePair();
		const s = await startApple(kit.appleEnv, `?native=1&code_challenge=${challenge}`);
		expect(`${s.loc.origin}${s.loc.pathname}`).toBe(`${ISS}/auth/authorize`);
		expect(s.state.startsWith("n.")).toBe(true);
		expect(s.nonce).toBeTruthy();
		expect(s.loc.searchParams.get("client_id")).toBe(SERVICES_ID);
		expect(s.loc.searchParams.get("redirect_uri")).toBe(`${API}/auth/apple/callback`);
		expect(s.loc.searchParams.get("response_mode")).toBe("form_post");
		expect(s.loc.toString()).not.toContain(challenge);
		const set = setCookieOf(s.res, "tg_oauth_apple");
		expectAppleCookieAttrs(set);
		expect(set).toMatch(/;\s*Max-Age=600(;|$)/);
	});

	it("native: a missing or malformed challenge goes to the fixed app URL with no cookie", async () => {
		for (const q of [
			"?native=1",
			"?native=1&code_challenge=",
			`?native=1&code_challenge=${"a".repeat(42)}`,
			`?native=1&code_challenge=${"a".repeat(44)}`,
			`?native=1&code_challenge=${"a".repeat(42)}%2B`,
		]) {
			const res = await callWith(kit.appleEnv, `/auth/apple/start${q}`);
			expect(res.status, q).toBe(302);
			expect(res.headers.get("Location"), q).toBe(`${APP_CALLBACK}?error=bad_request`);
			expect(setCookieOf(res, "tg_oauth_apple"), q).toBe("");
		}
	});
});

describe("Apple start: fails closed when misconfigured", () => {
	const settings = ["APPLE_SERVICES_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"];
	for (const name of settings) {
		for (const value of ["", "   ", undefined]) {
			it(`${name}=${JSON.stringify(value)}: web 500 misconfigured, native to the app URL, no cookie`, async () => {
				const broken = { ...kit.appleEnv, [name]: value } as unknown as Env;
				const { challenge } = await pkcePair();
				const web = await callWith(broken, "/auth/apple/start");
				expect(web.status).toBe(500);
				expect(await web.json()).toMatchObject({ error: { code: "misconfigured" } });
				expect(setCookieOf(web, "tg_oauth_apple")).toBe("");
				expect(web.headers.get("Location")).toBeNull();

				const nat = await callWith(
					broken,
					`/auth/apple/start?native=1&code_challenge=${challenge}`,
				);
				expect(nat.status).toBe(302);
				expect(nat.headers.get("Location")).toBe(`${APP_CALLBACK}?error=misconfigured`);
				expect(setCookieOf(nat, "tg_oauth_apple")).toBe("");
			});
		}
	}

	it("a short SESSION_SECRET is misconfigured too", async () => {
		const broken = { ...kit.appleEnv, SESSION_SECRET: "short" } as unknown as Env;
		expect((await callWith(broken, "/auth/apple/start")).status).toBe(500);
	});

	it("an unusable private key fails closed at the exchange, without calling Apple (web 500, native app URL)", async () => {
		const broken = {
			...kit.appleEnv,
			APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\n!!!not base64!!!\n-----END PRIVATE KEY-----",
		} as unknown as Env;
		const fetchSpy = mockFetch(() => undefined);
		const web = await startApple(broken);
		const res = await postAppleCallback(broken, { state: web.state, code: "c" }, web.cookie);
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ error: { code: "misconfigured" } });
		expect(cookieOf(res, "tg_session")).toBe("");

		const { challenge } = await pkcePair();
		const nat = await startApple(broken, `?native=1&code_challenge=${challenge}`);
		const nres = await postAppleCallback(broken, { state: nat.state, code: "c" }, nat.cookie);
		expect(nres.status).toBe(303);
		expect(nres.headers.get("Location")).toBe(`${APP_CALLBACK}?error=misconfigured`);
		expect(fetchSpy.calls).toHaveLength(0);
	});

	it("a valid base64 key that is not a P-256 PKCS8 key is also misconfigured", async () => {
		const broken = {
			...kit.appleEnv,
			APPLE_PRIVATE_KEY: btoa("definitely not a key"),
		} as unknown as Env;
		const fetchSpy = mockFetch(() => undefined);
		const s = await startApple(broken);
		const res = await postAppleCallback(broken, { state: s.state, code: "c" }, s.cookie);
		expect(res.status).toBe(500);
		expect(fetchSpy.calls).toHaveLength(0);
	});
});

describe("Apple start: return_to", () => {
	const cancelTo = async (returnTo: string) => {
		const s = await startApple(kit.appleEnv, `?return_to=${encodeURIComponent(returnTo)}`);
		const res = await postAppleCallback(
			kit.appleEnv,
			{ state: s.state, error: "user_cancelled_authorize" },
			s.cookie,
		);
		expect(res.status).toBe(303);
		return res.headers.get("Location");
	};

	it("keeps our own web origins", async () => {
		expect(await cancelTo(`${WEB}/trips?x=1`)).toBe(`${WEB}/trips?x=1`);
		expect(await cancelTo("http://localhost:5173/plans")).toBe("http://localhost:5173/plans");
	});

	it("replaces any other target with the web app's home page", async () => {
		for (const evil of [
			"https://evil.example/",
			"//evil.example/x",
			"/\\evil.example",
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"https://tagalong.averrow.com.evil.example/",
			"https://tagalong.averrow.com@evil.example/",
			"https://evil.example/?https://tagalong.averrow.com/",
			"http://tagalong.averrow.com/",
			"https://tagalong.averrow.com:444/",
			"https://tagalong-api.averrow.com/me",
			"capacitor://localhost/",
			"https://localhost/",
			"com.averrow.budgetrip://auth/callback",
			"/relative",
			"",
		])
			expect(await cancelTo(evil), evil).toBe(`${WEB}/`);
	});
});

// ---------------------------------------------------------------------------
// Callback: state.
// ---------------------------------------------------------------------------

describe("Apple callback: state and cookie", () => {
	it("a missing cookie is 400 bad_state and never calls Apple", async () => {
		const s = await startApple(kit.appleEnv);
		const spy = mockFetch(() => undefined);
		const res = await postAppleCallback(kit.appleEnv, { state: s.state, code: "c" }, "");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_state" } });
		expect(cookieOf(res, "tg_session")).toBe("");
		expect(spy.calls).toHaveLength(0);
	});

	it("a state mismatch, a missing state, another flow's state and a tampered cookie are all 400 without calling Apple", async () => {
		const a = await startApple(kit.appleEnv);
		const b = await startApple(kit.appleEnv);
		const spy = mockFetch(() => undefined);
		const [name, value] = a.cookie.split("=") as [string, string];
		const tampered = `${name}=${value.slice(0, -3)}${value.endsWith("A") ? "B" : "A"}${value.slice(-2)}`;
		for (const [fields, cookie] of [
			[{ state: "nope", code: "c" }, a.cookie],
			[{ code: "c" }, a.cookie],
			[{ state: "", code: "c" }, a.cookie],
			[{ state: b.state, code: "c" }, a.cookie],
			[{ state: `${a.state}x`, code: "c" }, a.cookie],
			[{ state: a.state, code: "c" }, tampered],
			[{ state: a.state, code: "c" }, `tg_oauth_apple=${encodeURIComponent(JSON.stringify({ state: a.state, nonce: a.nonce, returnTo: `${WEB}/` }))}`],
		] as const) {
			const res = await postAppleCallback(kit.appleEnv, fields as Record<string, string>, cookie);
			expect(res.status, JSON.stringify(fields)).toBe(400);
			expect(cookieOf(res, "tg_session")).toBe("");
		}
		expect(spy.calls).toHaveLength(0);
	});

	it("the Google state cookie never satisfies the Apple callback", async () => {
		const g = await call("/auth/google/start");
		const gState = new URL(g.headers.get("Location") ?? "").searchParams.get("state") ?? "";
		const gCookie = cookieOf(g, "tg_oauth");
		const res = await postAppleCallback(kit.appleEnv, { state: gState, code: "c" }, gCookie);
		expect(res.status).toBe(400);
	});

	it("every outcome clears the state cookie with the attributes a browser needs to delete it", async () => {
		const a = await startApple(kit.appleEnv);
		const bad = await postAppleCallback(kit.appleEnv, { state: "x", code: "c" }, a.cookie);
		const b = await startApple(kit.appleEnv);
		const cancel = await postAppleCallback(
			kit.appleEnv,
			{ state: b.state, error: "user_cancelled_authorize" },
			b.cookie,
		);
		const ok = await webSignIn({ sub: uniqueSub() });
		for (const res of [bad, cancel, ok.res]) {
			const del = setCookieOf(res, "tg_oauth_apple");
			expect(del).toMatch(/^tg_oauth_apple=;/);
			expectAppleCookieAttrs(del);
			expect(del).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
		}
	});

	it("reused: once the browser has dropped the cookie, posting the same state again is 400", async () => {
		const sub = uniqueSub();
		const first = await webSignIn({ sub });
		expect(first.res.status).toBe(303);
		const spy = mockFetch(() => undefined);
		const again = await postAppleCallback(
			kit.appleEnv,
			{ state: first.started.state, code: "c2" },
			"",
		);
		expect(again.status).toBe(400);
		expect(spy.calls).toHaveLength(0);
		expect(await countUsers(sub)).toBe(1);
	});

	it("error=user_cancelled_authorize: web goes back to returnTo (303), native to the app URL, neither calls Apple", async () => {
		const spy = mockFetch(() => undefined);
		const w = await startApple(kit.appleEnv, `?return_to=${encodeURIComponent(`${WEB}/trips`)}`);
		const web = await postAppleCallback(
			kit.appleEnv,
			{ state: w.state, error: "user_cancelled_authorize", code: "ignored" },
			w.cookie,
		);
		expect(web.status).toBe(303);
		expect(web.headers.get("Location")).toBe(`${WEB}/trips`);
		expect(cookieOf(web, "tg_session")).toBe("");

		const { challenge } = await pkcePair();
		const n = await startApple(kit.appleEnv, `?native=1&code_challenge=${challenge}`);
		const nat = await postAppleCallback(
			kit.appleEnv,
			{ state: n.state, error: "user_cancelled_authorize" },
			n.cookie,
		);
		expect(nat.status).toBe(303);
		expect(nat.headers.get("Location")).toBe(`${APP_CALLBACK}?error=cancelled`);
		expect(spy.calls).toHaveLength(0);
	});

	it("an error with a wrong state is still 400 (state is checked first)", async () => {
		const s = await startApple(kit.appleEnv);
		const res = await postAppleCallback(
			kit.appleEnv,
			{ state: "wrong", error: "user_cancelled_authorize" },
			s.cookie,
		);
		expect(res.status).toBe(400);
	});

	it("native: a state mismatch goes to the app URL with bad_state", async () => {
		const { challenge } = await pkcePair();
		const n = await startApple(kit.appleEnv, `?native=1&code_challenge=${challenge}`);
		const spy = mockFetch(() => undefined);
		const res = await postAppleCallback(kit.appleEnv, { state: "n.other", code: "c" }, n.cookie);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`${APP_CALLBACK}?error=bad_state`);
		expect(spy.calls).toHaveLength(0);
	});

	it("a JSON body (not Apple's form) carries no state: 400", async () => {
		const s = await startApple(kit.appleEnv);
		const res = await callWith(kit.appleEnv, "/auth/apple/callback", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ISS, Cookie: s.cookie },
			body: JSON.stringify({ state: s.state, code: "c" }),
		});
		expect(res.status).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// id_token verification (unit, with Apple's keys endpoint mocked).
// ---------------------------------------------------------------------------

describe("verifyAppleIdToken", () => {
	const NONCE = "flow-nonce-0001";
	const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) =>
		signJwt(claims, kit.rsaPrivate, { alg: "RS256", kid: kit.kid, ...header });
	const good = (over: Record<string, unknown> = {}) => claimsFor("sub-unit", NONCE, over);
	const keys = (body: () => unknown = () => kit.jwks) => {
		let n = 0;
		mockFetch((url) => {
			if (url.href !== KEYS_URL) return undefined;
			n++;
			return new Response(JSON.stringify(body()), {
				headers: { "Content-Type": "application/json" },
			});
		});
		return () => n;
	};
	const rejects = (p: Promise<unknown>) =>
		expect(p).rejects.toMatchObject({ status: 401, code: "apple_bad_token" });

	it("accepts a good token and returns its claims", async () => {
		keys();
		const c = await verifyAppleIdToken(await sign(good()), SERVICES_ID, NONCE);
		expect(c).toMatchObject({ sub: "sub-unit", iss: ISS, email_verified: true });
	});

	it('reads email_verified / is_private_email as "true", true, "false" or false', async () => {
		keys();
		for (const [v, want] of [
			["true", true],
			[true, true],
			["false", false],
			[false, false],
		] as const) {
			const c = await verifyAppleIdToken(
				await sign(good({ email_verified: v, is_private_email: v })),
				SERVICES_ID,
				NONCE,
			);
			expect(c.email_verified, String(v)).toBe(want);
			expect(c.is_private_email, String(v)).toBe(want);
		}
		// Anything else is not a boolean Apple sends: the token is refused.
		await rejects(verifyAppleIdToken(await sign(good({ email_verified: "yes" })), SERVICES_ID, NONCE));
		await rejects(verifyAppleIdToken(await sign(good({ email_verified: 1 })), SERVICES_ID, NONCE));
	});

	it("rejects a bad signature: payload swapped after signing, a stranger's key with Apple's kid, a truncated signature", async () => {
		keys();
		const token = await sign(good());
		const [h, , s] = token.split(".");
		await rejects(
			verifyAppleIdToken(`${h}.${b64json(good({ sub: "someone-else" }))}.${s}`, SERVICES_ID, NONCE),
		);
		const stranger = await newRsa();
		await rejects(
			verifyAppleIdToken(
				await signJwt(good(), stranger.privateKey, { alg: "RS256", kid: kit.kid }),
				SERVICES_ID,
				NONCE,
			),
		);
		await rejects(verifyAppleIdToken(`${h}.${token.split(".")[1]}.${s?.slice(0, 20)}`, SERVICES_ID, NONCE));
		await rejects(verifyAppleIdToken(`${h}.${token.split(".")[1]}.`, SERVICES_ID, NONCE));
		await rejects(verifyAppleIdToken(`${h}.${token.split(".")[1]}.***`, SERVICES_ID, NONCE));
	});

	it("rejects alg none, HS256 (keyed with Apple's public modulus), RS512 and a missing kid, before fetching keys", async () => {
		const fetches = keys();
		const payload = b64json(good());
		await rejects(
			verifyAppleIdToken(`${b64json({ alg: "none", kid: kit.kid })}.${payload}.`, SERVICES_ID, NONCE),
		);
		await rejects(
			verifyAppleIdToken(`${b64json({ alg: "none" })}.${payload}.`, SERVICES_ID, NONCE),
		);
		// The classic RS/HS confusion: HMAC keyed with the public key material.
		const hmac = await crypto.subtle.importKey(
			"raw",
			enc.encode(kit.rsaPublicJwk.n ?? ""),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const hsInput = `${b64json({ alg: "HS256", kid: kit.kid })}.${payload}`;
		const hsSig = b64url(await crypto.subtle.sign("HMAC", hmac, enc.encode(hsInput)));
		await rejects(verifyAppleIdToken(`${hsInput}.${hsSig}`, SERVICES_ID, NONCE));
		await rejects(verifyAppleIdToken(await sign(good(), { alg: "RS512" }), SERVICES_ID, NONCE));
		await rejects(verifyAppleIdToken(await sign(good(), { kid: undefined }), SERVICES_ID, NONCE));
		await rejects(verifyAppleIdToken(await sign(good(), { kid: "" }), SERVICES_ID, NONCE));
		expect(fetches()).toBe(0);
	});

	it("rejects tokens that aren't three parts or aren't JSON", async () => {
		keys();
		const token = await sign(good());
		for (const t of ["", "a.b", `${token}.extra`, "x.y.z", `${b64url(enc.encode("not json"))}.${b64json(good())}.sig`])
			await rejects(verifyAppleIdToken(t, SERVICES_ID, NONCE));
	});

	it("unknown kid: refetches the keys exactly once and accepts a rotated-in key", async () => {
		// The cache holds yesterday's keys; Apple has since added a new one.
		await primeJwksCache(kit.jwks);
		const cached = await caches.default.match(new Request(KEYS_URL));
		expect(cached, "caches.default should work in the test runtime").toBeTruthy();
		const rotated = await newRsa();
		const kid2 = `kid2-${crypto.randomUUID()}`;
		const pub = (await crypto.subtle.exportKey("jwk", rotated.publicKey)) as JsonWebKey;
		const fetches = keys(() => ({
			keys: [
				...kit.jwks.keys,
				{ kty: "EC", kid: "ec-key", crv: "P-256", x: "x", y: "y" }, // skipped, not fatal
				{ kty: "RSA", kid: kid2, use: "sig", alg: "RS256", n: pub.n, e: pub.e },
			],
		}));
		const token = await signJwt(good(), rotated.privateKey, { alg: "RS256", kid: kid2 });
		const c = await verifyAppleIdToken(token, SERVICES_ID, NONCE);
		expect(c.sub).toBe("sub-unit");
		expect(fetches()).toBe(1);
	});

	it("unknown kid that Apple doesn't have either: one refetch, then rejected (no loop)", async () => {
		await primeJwksCache(kit.jwks);
		const fetches = keys();
		const stranger = await newRsa();
		await rejects(
			verifyAppleIdToken(
				await signJwt(good(), stranger.privateKey, { alg: "RS256", kid: "no-such-kid" }),
				SERVICES_ID,
				NONCE,
			),
		);
		expect(fetches()).toBe(1);
	});

	it("an unreachable or broken keys endpoint fails as 502, never as a pass", async () => {
		await caches.default.delete(new Request(KEYS_URL));
		const token = await sign(good());
		mockFetch((url) => (url.href === KEYS_URL ? new Response("down", { status: 503 }) : undefined));
		await expect(verifyAppleIdToken(token, SERVICES_ID, NONCE)).rejects.toMatchObject({
			status: 502,
			code: "apple_keys_failed",
		});
		vi.restoreAllMocks();
		mockFetch((url) => {
			if (url.href === KEYS_URL) throw new TypeError("network down");
			return undefined;
		});
		await expect(verifyAppleIdToken(token, SERVICES_ID, NONCE)).rejects.toMatchObject({
			status: 502,
		});
		vi.restoreAllMocks();
		mockFetch((url) => (url.href === KEYS_URL ? new Response("{not json") : undefined));
		await expect(verifyAppleIdToken(token, SERVICES_ID, NONCE)).rejects.toMatchObject({
			status: 502,
		});
	});

	it("rejects a wrong issuer", async () => {
		keys();
		for (const iss of [
			"https://appleid.apple.com/",
			"http://appleid.apple.com",
			"https://evil.example",
			"appleid.apple.com",
			"https://accounts.google.com",
		])
			await rejects(verifyAppleIdToken(await sign(good({ iss })), SERVICES_ID, NONCE));
		await rejects(verifyAppleIdToken(await sign(good({ iss: undefined })), SERVICES_ID, NONCE));
	});

	it("rejects a wrong audience; accepts an audience list that includes ours", async () => {
		keys();
		for (const aud of ["com.averrow.other", "com.averrow.budgetrip", ["x", "y"], [], ""])
			await rejects(verifyAppleIdToken(await sign(good({ aud })), SERVICES_ID, NONCE));
		await rejects(verifyAppleIdToken(await sign(good({ aud: undefined })), SERVICES_ID, NONCE));
		const c = await verifyAppleIdToken(
			await sign(good({ aud: ["other", SERVICES_ID] })),
			SERVICES_ID,
			NONCE,
		);
		expect(c.sub).toBe("sub-unit");
	});

	it("rejects an expired token, a missing exp and a non-numeric exp", async () => {
		keys();
		await rejects(verifyAppleIdToken(await sign(good({ exp: nowS() - 5 })), SERVICES_ID, NONCE));
		await rejects(verifyAppleIdToken(await sign(good({ exp: undefined })), SERVICES_ID, NONCE));
		await rejects(
			verifyAppleIdToken(await sign(good({ exp: String(nowS() + 600) })), SERVICES_ID, NONCE),
		);
	});

	it("rejects a nonce mismatch, a missing nonce and a prefix / suffix of ours", async () => {
		keys();
		for (const nonce of ["other", "", `${NONCE}x`, NONCE.slice(0, -1), NONCE.toUpperCase(), undefined])
			await rejects(verifyAppleIdToken(await sign(good({ nonce })), SERVICES_ID, NONCE));
	});

	it("rejects a missing, empty or overlong sub and an invalid email", async () => {
		keys();
		for (const sub of [undefined, "", "x".repeat(256), 42])
			await rejects(verifyAppleIdToken(await sign(good({ sub })), SERVICES_ID, NONCE));
		await rejects(
			verifyAppleIdToken(await sign(good({ email: "<script>@x" })), SERVICES_ID, NONCE),
		);
	});
});

// ---------------------------------------------------------------------------
// Callback: the id_token through the route.
// ---------------------------------------------------------------------------

describe("Apple callback: a rejected id_token creates nothing", () => {
	const cases: [string, Partial<AppleReply>][] = [
		["expired", { claims: { exp: nowS() - 60 } }],
		["wrong iss", { claims: { iss: "https://evil.example" } }],
		["wrong aud", { claims: { aud: "com.someone.else" } }],
		["nonce mismatch", { claims: { nonce: "attacker-nonce" } }],
	];
	for (const [label, over] of cases) {
		it(`${label}: web 401, no session, no user; native to the app URL, no code`, async () => {
			const sub = uniqueSub();
			// claimsFor's nonce comes from the flow unless overridden.
			const reply = { sub, ...over } as AppleReply;
			const web = await webSignIn(reply);
			expect(web.res.status).toBe(401);
			expect(await web.res.json()).toMatchObject({ error: { code: "apple_bad_token" } });
			expect(web.session).toBe("");

			const before = await countCodes();
			const { challenge } = await pkcePair();
			const n = await startApple(kit.appleEnv, `?native=1&code_challenge=${challenge}`);
			mockApple(kit, reply, () => n.nonce);
			const nat = await postAppleCallback(kit.appleEnv, { state: n.state, code: "c" }, n.cookie);
			expect(nat.status).toBe(303);
			expect(nat.headers.get("Location")).toBe(`${APP_CALLBACK}?error=apple_bad_token`);
			expect(cookieOf(nat, "tg_session")).toBe("");
			expect(await countCodes()).toBe(before);
			expect(await countUsers(sub)).toBe(0);
		});
	}

	it("Apple's token endpoint failing is 502 apple_token_failed, and creates nothing", async () => {
		const s = await startApple(kit.appleEnv);
		mockFetch((url) =>
			url.href === `${ISS}/auth/token`
				? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
				: undefined,
		);
		const res = await postAppleCallback(kit.appleEnv, { state: s.state, code: "c" }, s.cookie);
		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({ error: { code: "apple_token_failed" } });
	});

	it("a token response without id_token is 502 apple_bad_token", async () => {
		const s = await startApple(kit.appleEnv);
		mockFetch((url) =>
			url.href === `${ISS}/auth/token`
				? new Response(JSON.stringify({ access_token: "at", refresh_token: "rt" }))
				: undefined,
		);
		const res = await postAppleCallback(kit.appleEnv, { state: s.state, code: "c" }, s.cookie);
		expect(res.status).toBe(502);
	});
});

// ---------------------------------------------------------------------------
// Callback: the account.
// ---------------------------------------------------------------------------

describe("Apple callback: email", () => {
	it('email_verified "true" or true stores the id_token email; "false" stores none', async () => {
		for (const [v, stored] of [
			["true", true],
			[true, true],
			["false", false],
			[false, false],
		] as const) {
			const sub = uniqueSub();
			const email = `${sub}@example.org`;
			const r = await webSignIn({
				sub,
				claims: { email, email_verified: v, is_private_email: "false" },
			});
			expect(r.res.status, String(v)).toBe(303);
			const body = await me(r.session);
			expect(body.email, String(v)).toBe(stored ? email : "");
			// The interstitial / label never falls back to an unverified address.
			expect((await userRow(sub))?.email).toBe(stored ? email : "");
		}
	});

	it("no email claim at all: the account still signs in, with no email", async () => {
		const sub = uniqueSub();
		const r = await webSignIn({ sub, claims: { email: undefined, email_verified: undefined } });
		expect(r.res.status).toBe(303);
		expect((await me(r.session)).email).toBe("");
	});

	it("a private relay address is stored as the email", async () => {
		const sub = uniqueSub();
		const relay = `abc123xyz.${sub.slice(2, 10)}@privaterelay.appleid.com`;
		const r = await webSignIn({
			sub,
			claims: { email: relay, email_verified: true, is_private_email: true },
		});
		expect((await me(r.session)).email).toBe(relay);
	});

	it("the unsigned `user` email is never used, even when the id_token has none", async () => {
		const sub = uniqueSub();
		const victim = "victim@example.com";
		const r = await webSignIn(
			{ sub, claims: { email: undefined, email_verified: undefined } },
			{ user: JSON.stringify({ name: { firstName: "Eve" }, email: victim }) },
		);
		expect((await me(r.session)).email).toBe("");
		const r2 = await webSignIn(
			{ sub: uniqueSub() },
			{ user: JSON.stringify({ name: { firstName: "Eve" }, email: victim }) },
		);
		expect((await me(r2.session)).email).not.toBe(victim);
	});

	it("a returning user's email updates to a new verified one but is never blanked", async () => {
		const sub = uniqueSub();
		const first = await webSignIn({
			sub,
			claims: { email: `one.${sub}@example.org`, email_verified: true },
		});
		const id = (await me(first.session)).id;
		const second = await webSignIn({
			sub,
			claims: { email: `two.${sub}@example.org`, email_verified: true },
		});
		expect(await me(second.session)).toMatchObject({ id, email: `two.${sub}@example.org` });
		const third = await webSignIn({ sub, claims: { email: undefined, email_verified: undefined } });
		expect(await me(third.session)).toMatchObject({ id, email: `two.${sub}@example.org` });
	});
});

describe("Apple callback: the id_token in the form body is ignored", () => {
	it("identity comes only from the token endpoint, even if the posted id_token is validly signed", async () => {
		const real = uniqueSub("real");
		const injected = uniqueSub("injected");
		const s = await startApple(kit.appleEnv);
		const forgedButSigned = await signJwt(claimsFor(injected, s.nonce), kit.rsaPrivate, {
			alg: "RS256",
			kid: kit.kid,
		});
		mockApple(kit, { sub: real }, () => s.nonce);
		const res = await postAppleCallback(
			kit.appleEnv,
			{ state: s.state, code: "c", id_token: forgedButSigned },
			s.cookie,
		);
		expect(res.status).toBe(303);
		expect(await countUsers(real)).toBe(1);
		expect(await countUsers(injected)).toBe(0);
	});

	it("a posted id_token without a code does not sign anyone in", async () => {
		const injected = uniqueSub("injected");
		const s = await startApple(kit.appleEnv, `?return_to=${encodeURIComponent(`${WEB}/x`)}`);
		const token = await signJwt(claimsFor(injected, s.nonce), kit.rsaPrivate, {
			alg: "RS256",
			kid: kit.kid,
		});
		const spy = mockFetch(() => undefined);
		const res = await postAppleCallback(kit.appleEnv, { state: s.state, id_token: token }, s.cookie);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`${WEB}/x`);
		expect(cookieOf(res, "tg_session")).toBe("");
		expect(spy.calls).toHaveLength(0);
		expect(await countUsers(injected)).toBe(0);
	});
});

describe("Apple callback: first-sign-in `user` name", () => {
	const nameFrom = async (user: string | undefined) => {
		const sub = uniqueSub();
		const r = await webSignIn({ sub }, user === undefined ? {} : { user });
		expect(r.res.status).toBe(303);
		return (await me(r.session)).display_name;
	};

	it("uses a valid name, trimmed and joined", async () => {
		expect(
			await nameFrom(JSON.stringify({ name: { firstName: "  Grace ", lastName: " Hopper" } })),
		).toBe("Grace Hopper");
		expect(await nameFrom(JSON.stringify({ name: { firstName: "Cher" } }))).toBe("Cher");
		expect(
			await nameFrom(JSON.stringify({ name: { firstName: "Zoë", lastName: "Ångström" }, extra: 1 })),
		).toBe("Zoë Ångström");
	});

	it("falls back to Traveller for a missing, malformed, malicious or overlong name", async () => {
		for (const user of [
			undefined,
			"",
			"not json",
			"null",
			"[]",
			'"Ada"',
			JSON.stringify({}),
			JSON.stringify({ name: "Ada Lovelace" }),
			JSON.stringify({ name: { firstName: 42 } }),
			JSON.stringify({ name: { firstName: "   ", lastName: "" } }),
			JSON.stringify({ name: { firstName: "x".repeat(61) } }),
			JSON.stringify({ name: { firstName: "x".repeat(40), lastName: "y".repeat(40) } }),
			JSON.stringify({ name: { firstName: "Ada\u0000" } }),
			JSON.stringify({ name: { firstName: "Ada\nLovelace" } }),
			JSON.stringify({ name: { firstName: "Ada‮ecalevol" } }),
			JSON.stringify({ name: { firstName: "Ada​" } }),
			JSON.stringify({ name: { firstName: "Ada" }, email: "x".repeat(300) }),
			JSON.stringify({ name: { firstName: "Ada" }, pad: "x".repeat(2100) }),
		])
			expect(await nameFrom(user), String(user).slice(0, 60)).toBe("Traveller");
	});

	it("never renames an existing account, even with a valid name", async () => {
		const sub = uniqueSub();
		const first = await webSignIn({ sub }, { user: JSON.stringify({ name: { firstName: "Ada" } }) });
		const second = await webSignIn(
			{ sub },
			{ user: JSON.stringify({ name: { firstName: "Mallory", lastName: "Evil" } }) },
		);
		const a = await me(first.session);
		const b = await me(second.session);
		expect(b.id).toBe(a.id);
		expect(b.display_name).toBe("Ada");
	});
});

describe("Apple callback: account mapping", () => {
	it("never links to an existing Google account with the same email", async () => {
		const google = await signedInUser();
		const email = `${google.id}@example.com`; // signedInUser's address
		const sub = uniqueSub();
		const r = await webSignIn({
			sub,
			claims: { email, email_verified: true, is_private_email: false },
		});
		expect(r.res.status).toBe(303);
		const apple = await me(r.session);
		expect(apple.id).not.toBe(google.id);
		expect(apple.email).toBe(email);
		expect(apple.sign_in_providers).toEqual(["apple"]);
		const g = await me(google.cookie);
		expect(g.sign_in_providers).toEqual(["google"]);
		const gRow = await env.DB.prepare("SELECT apple_sub FROM users WHERE id = ?")
			.bind(google.id)
			.first<{ apple_sub: string | null }>();
		expect(gRow?.apple_sub).toBeNull();
	});

	it("a returning Apple user maps to the same account, one row", async () => {
		const sub = uniqueSub();
		const a = await webSignIn({ sub });
		const b = await webSignIn({ sub });
		const c = await webSignIn({ sub, claims: { aud: [SERVICES_ID] } });
		expect((await me(a.session)).id).toBe((await me(b.session)).id);
		expect((await me(c.session)).id).toBe((await me(a.session)).id);
		expect(await countUsers(sub)).toBe(1);
		expect((await userRow(sub))?.google_sub).toBe(`apple:${sub}`);
	});

	it("a tombstone that still carries the apple_sub is never signed in to (401 account_deleted)", async () => {
		const sub = uniqueSub();
		const first = await webSignIn({ sub });
		const id = (await me(first.session)).id;
		await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), id)
			.run();
		const again = await webSignIn({ sub });
		expect(again.res.status).toBe(401);
		expect(await again.res.json()).toMatchObject({ error: { code: "account_deleted" } });
		expect(again.session).toBe("");
	});
});

describe("Apple refresh token at rest", () => {
	it("is stored encrypted (iv.ciphertext), never as plaintext, and decrypts", async () => {
		const sub = uniqueSub();
		const rt = `r.${crypto.randomUUID()}.plain-refresh-token`;
		await webSignIn({ sub, refreshToken: rt });
		const stored = (await userRow(sub))?.apple_refresh_token_enc ?? "";
		expect(stored).not.toContain(rt);
		expect(stored).not.toContain(btoa(rt).replace(/=+$/, ""));
		expect(stored).toMatch(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
		expect(await decryptRefreshToken(env, stored)).toBe(rt);
	});

	it("a second sign-in without a refresh token keeps the old one; with one, replaces it", async () => {
		const sub = uniqueSub();
		await webSignIn({ sub, refreshToken: "rt-one" });
		await webSignIn({ sub, refreshToken: null });
		expect(await decryptRefreshToken(env, (await userRow(sub))?.apple_refresh_token_enc ?? "")).toBe(
			"rt-one",
		);
		await webSignIn({ sub, refreshToken: "rt-two" });
		expect(await decryptRefreshToken(env, (await userRow(sub))?.apple_refresh_token_enc ?? "")).toBe(
			"rt-two",
		);
	});

	it("no refresh token on a first sign-in stores NULL", async () => {
		const sub = uniqueSub();
		await webSignIn({ sub, refreshToken: null });
		expect((await userRow(sub))?.apple_refresh_token_enc).toBeNull();
	});

	it("encryption uses a fresh IV, binds to SESSION_SECRET and rejects tampering", async () => {
		const a = await encryptRefreshToken(env, "same");
		const b = await encryptRefreshToken(env, "same");
		expect(a).not.toBe(b);
		expect(await decryptRefreshToken(env, a)).toBe("same");
		const other = { ...env, SESSION_SECRET: "another-secret-0123456789abcdef0123456789" } as Env;
		expect(await decryptRefreshToken(other, a)).toBeNull();
		const [iv, ct] = a.split(".") as [string, string];
		const flipped = `${iv}.${ct.slice(0, -2)}${ct.endsWith("AA") ? "BA" : "AA"}`;
		expect(await decryptRefreshToken(env, flipped)).toBeNull();
		for (const bad of ["", ".", "abc", `${iv}.`, `.${ct}`, `${iv}.${ct}.x`, `${iv.slice(2)}.${ct}`])
			expect(await decryptRefreshToken(env, bad), bad).toBeNull();
	});
});

describe("Apple client secret", () => {
	it("the token request carries an ES256 JWT (header, claims, 5-minute life) that verifies with the public key", async () => {
		const r = await webSignIn({ sub: uniqueSub() });
		expect(r.apple.tokenForms).toHaveLength(1);
		const form = r.apple.tokenForms[0] as URLSearchParams;
		expect(form.get("client_id")).toBe(SERVICES_ID);
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("redirect_uri")).toBe(`${API}/auth/apple/callback`);
		expect(form.get("code")).toMatch(/^code-/);
		await assertClientSecret(kit, form.get("client_secret") ?? "");
		// The secret is minted per request.
		const r2 = await webSignIn({ sub: uniqueSub() });
		const secret2 = r2.apple.tokenForms[0]?.get("client_secret");
		expect(decodeJson(secret2?.split(".")[0] ?? "")).toEqual({ alg: "ES256", kid: "KEY1234567" });
	});
});

// ---------------------------------------------------------------------------
// Native.
// ---------------------------------------------------------------------------

describe("Apple native sign-in", () => {
	const exchange = (code: string, verifier: string) =>
		call("/auth/native/exchange", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "capacitor://localhost",
				"CF-Connecting-IP": `198.51.100.${Math.floor(Math.random() * 250)}`,
			},
			body: JSON.stringify({ code, code_verifier: verifier }),
		});

	async function nativeSignIn(reply: AppleReply, user?: string) {
		const pk = await pkcePair();
		const s = await startApple(
			kit.appleEnv,
			`?native=1&code_challenge=${pk.challenge}&return_to=${encodeURIComponent("https://evil.example/")}`,
		);
		mockApple(kit, reply, () => s.nonce);
		const res = await postAppleCallback(
			kit.appleEnv,
			{ state: s.state, code: "c", ...(user ? { user } : {}) },
			s.cookie,
		);
		vi.restoreAllMocks();
		return { res, ...pk };
	}

	const linkOf = async (res: Response) => {
		const html = await res.text();
		const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) =>
			(m[1] ?? "").replace(/&amp;/g, "&"),
		);
		return { html, hrefs };
	};

	it("issues a one-time code on https://tagalong.averrow.com/auth/app-callback, redeemable once with the PKCE verifier", async () => {
		const sub = uniqueSub();
		const { res, verifier } = await nativeSignIn({ sub });
		expect(res.status).toBe(200);
		expect(cookieOf(res, "tg_session")).toBe("");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const { hrefs } = await linkOf(res);
		expect(hrefs).toHaveLength(1);
		const link = new URL(hrefs[0] ?? "");
		expect(`${link.origin}${link.pathname}`).toBe(APP_CALLBACK);
		expect([...link.searchParams.keys()]).toEqual(["code"]);
		const code = link.searchParams.get("code") ?? "";

		// Wrong verifier: refused, and it burns the code.
		const wrong = await pkcePair();
		expect((await exchange(code, wrong.verifier)).status).toBe(400);
		expect((await exchange(code, verifier)).status).toBe(400);
	});

	it("the right verifier gets a bearer for the Apple account; a replay is refused", async () => {
		const sub = uniqueSub();
		const { res, verifier } = await nativeSignIn(
			{ sub },
			JSON.stringify({ name: { firstName: "Nat" } }),
		);
		const { hrefs } = await linkOf(res);
		const code = new URL(hrefs[0] ?? "").searchParams.get("code") ?? "";
		const ok = await exchange(code, verifier);
		expect(ok.status).toBe(200);
		const { token } = await ok.json<{ token: string }>();
		const meRes = await call("/me", { headers: { Authorization: `Bearer ${token}` } });
		const body = await meRes.json<{ display_name: string; sign_in_providers: string[] }>();
		expect(body).toMatchObject({ display_name: "Nat", sign_in_providers: ["apple"] });
		expect((await exchange(code, verifier)).status).toBe(400);
	});

	it("escapes the signed-in label in the interstitial", async () => {
		const sub = uniqueSub();
		const { res } = await nativeSignIn(
			{ sub, claims: { email: undefined, email_verified: undefined } },
			JSON.stringify({ name: { firstName: '<img src=x onerror="alert(1)">' } }),
		);
		const { html, hrefs } = await linkOf(res);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(hrefs).toHaveLength(1);
	});

	it("an Apple error during the exchange goes back to the app URL with a short code", async () => {
		const pk = await pkcePair();
		const s = await startApple(kit.appleEnv, `?native=1&code_challenge=${pk.challenge}`);
		mockFetch((url) =>
			url.href === `${ISS}/auth/token` ? new Response("{}", { status: 500 }) : undefined,
		);
		const res = await postAppleCallback(kit.appleEnv, { state: s.state, code: "c" }, s.cookie);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`${APP_CALLBACK}?error=apple_token_failed`);
	});

	it("a web-state callback never yields a native code, and a native one never a cookie session", async () => {
		const sub = uniqueSub();
		const before = await countCodes();
		const web = await webSignIn({ sub });
		expect(web.session).not.toBe("");
		expect(await countCodes()).toBe(before);
		const nat = await nativeSignIn({ sub });
		expect(cookieOf(nat.res, "tg_session")).toBe("");
		expect(await countCodes()).toBe(before + 1);
	});
});
