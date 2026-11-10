/**
 * Test kit for Sign in with Apple (phase 7): a mocked Apple. An RSA key signs
 * id_tokens and is served as the JWKS; an EC P-256 key stands in for the .p8.
 * Nothing here reaches the network: every appleid.apple.com call is answered
 * by a mockFetch route, and any other outbound call fails the test.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import { b64url, fromB64url } from "../auth/session.js";
import app from "../index.js";
import { API, json, mockFetch } from "./helpers.js";

export const APP_CALLBACK = "https://tagalong.averrow.com/auth/app-callback";
export const SERVICES_ID = "com.averrow.budgetrip.signin";
export const TEAM_ID = "TEAM123456";
export const KEY_ID = "KEY1234567";
export const ISS = "https://appleid.apple.com";

const enc = new TextEncoder();
export const b64json = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
export const decodeJson = (part: string) =>
	JSON.parse(new TextDecoder().decode(fromB64url(part) ?? new Uint8Array())) as Record<
		string,
		unknown
	>;

export interface AppleKit {
	ecPublic: CryptoKey;
	pem: string;
	rsaPrivate: CryptoKey;
	rsaPublicJwk: JsonWebKey;
	kid: string;
	jwks: { keys: unknown[] };
	appleEnv: Env;
}

export const newRsa = async () =>
	(await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;

export async function makeAppleKit(): Promise<AppleKit> {
	const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const der = new Uint8Array(
		(await crypto.subtle.exportKey("pkcs8", ec.privateKey)) as ArrayBuffer,
	);
	const b64 = btoa(String.fromCharCode(...der));
	const label = ["PRIVATE", "KEY"].join(" ");
	const pem = `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;
	const rsa = await newRsa();
	const kid = `kid-${crypto.randomUUID()}`;
	const rsaPublicJwk = (await crypto.subtle.exportKey("jwk", rsa.publicKey)) as JsonWebKey;
	return {
		ecPublic: ec.publicKey,
		pem,
		rsaPrivate: rsa.privateKey,
		rsaPublicJwk,
		kid,
		jwks: {
			keys: [{ kty: "RSA", kid, use: "sig", alg: "RS256", n: rsaPublicJwk.n, e: rsaPublicJwk.e }],
		},
		appleEnv: {
			...env,
			APPLE_SERVICES_ID: SERVICES_ID,
			APPLE_TEAM_ID: TEAM_ID,
			APPLE_KEY_ID: KEY_ID,
			APPLE_PRIVATE_KEY: pem,
		} as unknown as Env,
	};
}

/** A random documentation-range IP, so the per-IP sign-in limit never couples tests. */
export const randomIp = () =>
	`198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

/**
 * Calls the Worker with the given env. Each call gets its own
 * CF-Connecting-IP unless one is given (sign-in endpoints are limited per IP).
 */
export async function callWith(
	envToUse: Env,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", randomIp());
	const ctx = createExecutionContext();
	const res = await app.fetch(new Request(`${API}${path}`, { ...init, headers }), envToUse, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

/** An RS256 JWT, signed by `signer`, with any header. */
export async function signJwt(
	claims: Record<string, unknown>,
	signer: CryptoKey,
	header: Record<string, unknown>,
): Promise<string> {
	const input = `${b64json(header)}.${b64json(claims)}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, enc.encode(input));
	return `${input}.${b64url(sig)}`;
}

export const nowS = () => Math.floor(Date.now() / 1000);

/** Good claims for `sub` and `nonce`; override or delete (undefined) any of them. */
export function claimsFor(
	sub: string,
	nonce: string,
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	const base: Record<string, unknown> = {
		iss: ISS,
		aud: SERVICES_ID,
		sub,
		iat: nowS(),
		exp: nowS() + 600,
		nonce,
		email: `${sub}@privaterelay.appleid.com`,
		email_verified: "true",
		is_private_email: "true",
		...over,
	};
	for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
	return base;
}

export const cookieOf = (res: Response, name: string) =>
	res.headers
		.getSetCookie()
		.find((h) => h.startsWith(`${name}=`))
		?.split(";")[0] ?? "";

export const setCookieOf = (res: Response, name: string) =>
	res.headers.getSetCookie().find((h) => h.startsWith(`${name}=`)) ?? "";

/** Checks an ES256 client secret the way Apple would. */
export async function assertClientSecret(kit: AppleKit, secret: string) {
	const [h, p, s] = secret.split(".");
	expect(decodeJson(h ?? "")).toEqual({ alg: "ES256", kid: KEY_ID });
	const claims = decodeJson(p ?? "") as { iat: number; exp: number };
	expect(claims).toMatchObject({ iss: TEAM_ID, sub: SERVICES_ID, aud: ISS });
	expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "sub"]);
	expect(claims.exp - claims.iat).toBe(300);
	expect(Math.abs(claims.iat - nowS())).toBeLessThanOrEqual(5);
	const sig = fromB64url(s ?? "");
	expect(sig?.length).toBe(64); // raw r||s (JWS), not DER
	expect(
		await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			kit.ecPublic,
			sig ?? new Uint8Array(),
			enc.encode(`${h}.${p}`),
		),
	).toBe(true);
}

export interface AppleReply {
	sub: string;
	/** Claim overrides (undefined deletes the claim). */
	claims?: Record<string, unknown>;
	/** null: Apple sends no refresh_token. */
	refreshToken?: string | null;
	/** Replaces the whole id_token (for alg / kid / signature tests). */
	idToken?: (nonce: string) => Promise<string>;
	/** What /auth/keys serves (default: the kit's JWKS). */
	jwks?: () => unknown;
}

/** Mocks Apple's token + keys endpoints. Records each call. */
export function mockApple(kit: AppleKit, reply: AppleReply, flowNonce: () => string) {
	const tokenForms: URLSearchParams[] = [];
	let keyFetches = 0;
	const m = mockFetch((url, init) => {
		if (url.origin !== ISS) return undefined;
		if (url.pathname === "/auth/keys") {
			keyFetches++;
			return json(reply.jwks ? reply.jwks() : kit.jwks);
		}
		if (url.pathname === "/auth/token") {
			return (async () => {
				const form = new URLSearchParams(String(init?.body ?? ""));
				tokenForms.push(form);
				const nonce = flowNonce();
				const idToken = reply.idToken
					? await reply.idToken(nonce)
					: await signJwt(claimsFor(reply.sub, nonce, reply.claims), kit.rsaPrivate, {
							alg: "RS256",
							kid: kit.kid,
						});
				return json({
					access_token: "at",
					token_type: "Bearer",
					expires_in: 3600,
					...(reply.refreshToken === null
						? {}
						: { refresh_token: reply.refreshToken ?? "rt-secret-value" }),
					id_token: idToken,
				});
			})();
		}
		return undefined;
	});
	return {
		tokenForms,
		get keyFetches() {
			return keyFetches;
		},
		calls: m.calls,
	};
}

export interface Started {
	res: Response;
	loc: URL;
	cookie: string;
	state: string;
	nonce: string;
}

export async function startApple(envToUse: Env, query = ""): Promise<Started> {
	const res = await callWith(envToUse, `/auth/apple/start${query}`);
	expect(res.status).toBe(302);
	const loc = new URL(res.headers.get("Location") ?? "");
	return {
		res,
		loc,
		cookie: cookieOf(res, "tg_oauth_apple"),
		state: loc.searchParams.get("state") ?? "",
		nonce: loc.searchParams.get("nonce") ?? "",
	};
}

export const postAppleCallback = (
	envToUse: Env,
	fields: Record<string, string>,
	cookie: string,
	extraHeaders: Record<string, string> = {},
) =>
	callWith(envToUse, "/auth/apple/callback", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Origin: ISS,
			...(cookie ? { Cookie: cookie } : {}),
			...extraHeaders,
		},
		body: new URLSearchParams(fields),
	});

/** A PKCE verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
	const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
	return { verifier, challenge };
}

/** The links (hrefs, &amp; decoded) on an HTML page. */
export async function linksOf(res: Response): Promise<{ html: string; hrefs: string[] }> {
	const html = await res.text();
	const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) =>
		(m[1] ?? "").replace(/&amp;/g, "&"),
	);
	return { html, hrefs };
}

/**
 * A native sign-in that failed: a 200 interstitial (never a redirect, never a
 * session cookie) whose one link is exactly the app callback with `error`.
 */
export async function expectNativeError(res: Response, error: string) {
	expect(res.status).toBe(200);
	expect(res.headers.get("Location")).toBeNull();
	expect(cookieOf(res, "tg_session")).toBe("");
	expect(res.headers.get("Content-Security-Policy") ?? "").toContain("default-src 'none'");
	expect(res.headers.get("Cache-Control")).toBe("no-store");
	const { hrefs } = await linksOf(res);
	expect(hrefs).toEqual([`${APP_CALLBACK}?error=${error}`]);
}

export const uniqueSub = (p = "s") => `${p}.${crypto.randomUUID().replace(/-/g, "")}.0101`;
