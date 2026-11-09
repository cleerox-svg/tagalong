/**
 * Phase 7 smoke tests: Sign in with Apple (web + native), /me providers, the
 * ES256 client secret and the RS256 id_token check. test-engineer extends these.
 *
 * Apple is mocked: an RSA key signs id_tokens and is served as the JWKS, and
 * an EC P-256 key stands in for the .p8. The APPLE_* config is passed in a
 * per-test env (wrangler.jsonc leaves it empty, which must fail closed).
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptRefreshToken } from "../auth/apple.js";
import { b64url, fromB64url } from "../auth/session.js";
import app from "../index.js";
import { API, call, json, mockFetch, signedInUser, WEB } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APP = "https://tagalong.averrow.com/auth/app-callback";
const SERVICES_ID = "com.averrow.budgetrip.signin";
const TEAM_ID = "TEAM123456";
const KEY_ID = "KEY1234567";
const ISS = "https://appleid.apple.com";

const enc = new TextEncoder();
const b64json = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

let ecPublic: CryptoKey;
let rsaPrivate: CryptoKey;
let jwks: { keys: unknown[] };
let kid: string;
let appleEnv: Env;

beforeAll(async () => {
	const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	ecPublic = ec.publicKey;
	const der = new Uint8Array(
		(await crypto.subtle.exportKey("pkcs8", ec.privateKey)) as ArrayBuffer,
	);
	const b64 = btoa(String.fromCharCode(...der));
	const label = ["PRIVATE", "KEY"].join(" ");
	const pem = `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;

	const rsa = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	rsaPrivate = rsa.privateKey;
	kid = `kid-${crypto.randomUUID()}`;
	const pub = (await crypto.subtle.exportKey("jwk", rsa.publicKey)) as JsonWebKey;
	jwks = { keys: [{ kty: "RSA", kid, use: "sig", alg: "RS256", n: pub.n, e: pub.e }] };

	appleEnv = {
		...env,
		APPLE_SERVICES_ID: SERVICES_ID,
		APPLE_TEAM_ID: TEAM_ID,
		APPLE_KEY_ID: KEY_ID,
		APPLE_PRIVATE_KEY: pem,
	} as unknown as Env;
});

/** Like helpers.call, with the Apple config set. */
async function callApple(path: string, init: RequestInit = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await app.fetch(new Request(`${API}${path}`, init), appleEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function idToken(claims: Record<string, unknown>, signer = rsaPrivate, keyId = kid) {
	const input = `${b64json({ alg: "RS256", kid: keyId })}.${b64json(claims)}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, enc.encode(input));
	return `${input}.${b64url(sig)}`;
}

const cookieOf = (res: Response, name: string) =>
	res.headers
		.getSetCookie()
		.find((h) => h.startsWith(`${name}=`))
		?.split(";")[0] ?? "";

/** Checks the ES256 client secret Apple would receive, as Apple would. */
async function assertClientSecret(secret: string) {
	const [h, p, s] = secret.split(".");
	expect(JSON.parse(new TextDecoder().decode(fromB64url(h ?? "") ?? undefined))).toEqual({
		alg: "ES256",
		kid: KEY_ID,
	});
	const claims = JSON.parse(new TextDecoder().decode(fromB64url(p ?? "") ?? undefined));
	expect(claims).toMatchObject({ iss: TEAM_ID, sub: SERVICES_ID, aud: ISS });
	expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
	const sig = fromB64url(s ?? "");
	expect(sig?.length).toBe(64); // raw r||s, not DER
	const ok = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		ecPublic,
		sig ?? new Uint8Array(),
		enc.encode(`${h}.${p}`),
	);
	expect(ok).toBe(true);
}

interface AppleMock {
	sub: string;
	email?: string;
	nonce?: string; // defaults to the flow's nonce
	refreshToken?: string;
}

/** Mocks Apple's token + keys endpoints for one sign-in. */
function mockApple(m: AppleMock, flowNonce: () => string) {
	const token = async (init: RequestInit | undefined): Promise<Response> => {
		const form = new URLSearchParams(String(init?.body ?? ""));
		expect(form.get("client_id")).toBe(SERVICES_ID);
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("redirect_uri")).toBe(`${API}/auth/apple/callback`);
		await assertClientSecret(form.get("client_secret") ?? "");
		return json({
			access_token: "at",
			token_type: "Bearer",
			refresh_token: m.refreshToken ?? "rt-secret-value",
			id_token: await idToken({
				iss: ISS,
				aud: SERVICES_ID,
				sub: m.sub,
				iat: Math.floor(Date.now() / 1000),
				exp: Math.floor(Date.now() / 1000) + 600,
				nonce: m.nonce ?? flowNonce(),
				email: m.email ?? `${m.sub}@privaterelay.appleid.com`,
				email_verified: "true",
				is_private_email: "true",
			}),
		});
	};
	return mockFetch((url, init) => {
		if (url.origin !== ISS) return undefined;
		if (url.pathname === "/auth/keys") return json(jwks);
		if (url.pathname === "/auth/token") return token(init);
		return undefined;
	});
}

async function start(query = "") {
	const res = await callApple(`/auth/apple/start${query}`);
	expect(res.status).toBe(302);
	const loc = new URL(res.headers.get("Location") ?? "");
	return { res, loc, cookie: cookieOf(res, "tg_oauth_apple") };
}

const postCallback = (fields: Record<string, string>, cookie: string) =>
	callApple("/auth/apple/callback", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Origin: ISS,
			Cookie: cookie,
		},
		body: new URLSearchParams(fields),
	});

describe("Sign in with Apple: start", () => {
	it("fails closed when Apple isn't configured", async () => {
		const res = await call("/auth/apple/start");
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ error: { code: "misconfigured" } });
		const nat = await call(`/auth/apple/start?native=1&code_challenge=${"a".repeat(43)}`);
		expect(nat.status).toBe(302);
		expect(nat.headers.get("Location")).toBe(`${APP}?error=misconfigured`);
	});

	it("redirects to Apple with form_post, our callback, state and nonce in a SameSite=None cookie", async () => {
		const { res, loc } = await start(`?return_to=${encodeURIComponent(`${WEB}/trips`)}`);
		expect(`${loc.origin}${loc.pathname}`).toBe(`${ISS}/auth/authorize`);
		expect(loc.searchParams.get("client_id")).toBe(SERVICES_ID);
		expect(loc.searchParams.get("redirect_uri")).toBe(`${API}/auth/apple/callback`);
		expect(loc.searchParams.get("response_type")).toBe("code");
		expect(loc.searchParams.get("response_mode")).toBe("form_post");
		expect(loc.searchParams.get("scope")).toBe("name email");
		expect(loc.searchParams.get("state")).toBeTruthy();
		expect(loc.searchParams.get("nonce")).toBeTruthy();
		const set = res.headers.getSetCookie().find((h) => h.startsWith("tg_oauth_apple=")) ?? "";
		expect(set).toMatch(/HttpOnly/i);
		expect(set).toMatch(/Secure/i);
		expect(set).toMatch(/SameSite=None/i);
		expect(set).toMatch(/Path=\/auth\/apple/);
		expect(set).toMatch(/Max-Age=600/);
	});

	it("rejects a native start without a valid challenge, on the fixed app URL", async () => {
		const res = await callApple("/auth/apple/start?native=1&code_challenge=short");
		expect(res.headers.get("Location")).toBe(`${APP}?error=bad_request`);
	});
});

describe("Sign in with Apple: callback", () => {
	it("web: verifies the id_token, creates the account once, starts a session (303)", async () => {
		const sub = `001234.${crypto.randomUUID().replace(/-/g, "")}.0101`;
		const { loc, cookie } = await start(`?return_to=${encodeURIComponent(`${WEB}/trips`)}`);
		const state = loc.searchParams.get("state") ?? "";
		mockApple({ sub }, () => loc.searchParams.get("nonce") ?? "");
		const res = await postCallback(
			{
				state,
				code: "c1",
				user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" } }),
			},
			cookie,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`${WEB}/trips`);
		const session = cookieOf(res, "tg_session");
		expect(session).not.toBe("");
		// The state cookie is single-use.
		expect(res.headers.getSetCookie().some((h) => /^tg_oauth_apple=;/.test(h))).toBe(true);

		const me = await call("/me", { cookie: session });
		expect(me.status).toBe(200);
		const body = await me.json<{
			display_name: string;
			email: string;
			sign_in_providers: string[];
		}>();
		expect(body.display_name).toBe("Ada Lovelace");
		expect(body.email).toBe(`${sub}@privaterelay.appleid.com`);
		expect(body.sign_in_providers).toEqual(["apple"]);

		const row = await env.DB.prepare(
			"SELECT id, google_sub, apple_refresh_token_enc FROM users WHERE apple_sub = ?",
		)
			.bind(sub)
			.first<{ id: string; google_sub: string; apple_refresh_token_enc: string }>();
		expect(row?.google_sub).toBe(`apple:${sub}`);
		expect(row?.apple_refresh_token_enc).not.toContain("rt-secret-value");
		expect(await decryptRefreshToken(env, row?.apple_refresh_token_enc ?? "")).toBe(
			"rt-secret-value",
		);
		vi.restoreAllMocks();

		// Second sign-in: same account; the unsigned `user` never renames it.
		const again = await start();
		mockApple({ sub }, () => again.loc.searchParams.get("nonce") ?? "");
		const res2 = await postCallback(
			{
				state: again.loc.searchParams.get("state") ?? "",
				code: "c2",
				user: JSON.stringify({ name: { firstName: "Mallory" } }),
			},
			again.cookie,
		);
		expect(res2.status).toBe(303);
		const me2 = await call("/me", { cookie: cookieOf(res2, "tg_session") });
		const body2 = await me2.json<{ id: string; display_name: string }>();
		expect(body2.id).toBe(row?.id);
		expect(body2.display_name).toBe("Ada Lovelace");
	});

	it("rejects a wrong state, a wrong nonce and a token not signed by Apple", async () => {
		const sub = `s-${crypto.randomUUID()}`;
		const a = await start();
		const bad = await postCallback({ state: "nope", code: "c" }, a.cookie);
		expect(bad.status).toBe(400);
		expect(cookieOf(bad, "tg_session")).toBe("");

		const b = await start();
		mockApple({ sub, nonce: "someone-elses-nonce" }, () => "");
		const wrongNonce = await postCallback(
			{ state: b.loc.searchParams.get("state") ?? "", code: "c" },
			b.cookie,
		);
		expect(wrongNonce.status).toBe(401);
		expect(cookieOf(wrongNonce, "tg_session")).toBe("");
		vi.restoreAllMocks();

		const forger = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const c = await start();
		const nonce = c.loc.searchParams.get("nonce") ?? "";
		const forgedToken = await idToken(
			{ iss: ISS, aud: SERVICES_ID, sub, exp: Math.floor(Date.now() / 1000) + 600, nonce },
			forger.privateKey,
		);
		mockFetch((url) => {
			if (url.pathname === "/auth/keys") return json(jwks);
			if (url.pathname === "/auth/token") return json({ id_token: forgedToken });
			return undefined;
		});
		const forged = await postCallback(
			{ state: c.loc.searchParams.get("state") ?? "", code: "c" },
			c.cookie,
		);
		expect(forged.status).toBe(401);
		const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE apple_sub = ?")
			.bind(sub)
			.first<{ n: number }>();
		expect(n?.n).toBe(0);
	});

	it("web: a cancel at Apple goes back to returnTo without a session", async () => {
		const a = await start(`?return_to=${encodeURIComponent(`${WEB}/`)}`);
		const res = await postCallback(
			{ state: a.loc.searchParams.get("state") ?? "", error: "user_cancelled_authorize" },
			a.cookie,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`${WEB}/`);
		expect(cookieOf(res, "tg_session")).toBe("");
	});

	it("native: shows the interstitial whose only link is the HTTPS app callback; the code exchanges", async () => {
		const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
		const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
		const sub = `n-${crypto.randomUUID()}`;
		const s = await start(`?native=1&code_challenge=${challenge}`);
		const state = s.loc.searchParams.get("state") ?? "";
		expect(state.startsWith("n.")).toBe(true);
		mockApple({ sub }, () => s.loc.searchParams.get("nonce") ?? "");
		const res = await postCallback({ state, code: "c" }, s.cookie);
		vi.restoreAllMocks();
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Security-Policy") ?? "").toContain("default-src 'none'");
		expect(cookieOf(res, "tg_session")).toBe("");
		const html = await res.text();
		expect(html).toContain("Open Budgetrip");
		const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) =>
			(m[1] ?? "").replace(/&amp;/g, "&"),
		);
		expect(hrefs).toHaveLength(1);
		expect(hrefs[0]?.startsWith(`${APP}?code=`)).toBe(true);
		const code = new URL(hrefs[0] ?? "").searchParams.get("code") ?? "";
		const ex = await call("/auth/native/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "capacitor://localhost" },
			body: JSON.stringify({ code, code_verifier: verifier }),
		});
		expect(ex.status).toBe(200);
	});

	it("native: a lost state cookie still ends on the app URL", async () => {
		const res = await postCallback({ state: `n.${crypto.randomUUID()}`, code: "c" }, "");
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`${APP}?error=bad_state`);
	});
});

describe("GET /me sign_in_providers", () => {
	it("lists google for a Google account", async () => {
		const id = `g-${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, 'G')",
		)
			.bind(id, `1${Date.now()}`, `${id}@example.com`)
			.run();
		const u = await signedInUser({ id });
		const me = await call("/me", { cookie: u.cookie });
		expect((await me.json<{ sign_in_providers: string[] }>()).sign_in_providers).toEqual([
			"google",
		]);
	});
});
