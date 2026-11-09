/**
 * Phase 7: Sign in with Apple (web and native), the protocol half. The routes
 * are in auth/routes.ts; this file talks to appleid.apple.com.
 *
 * - The client secret is a short-lived ES256 JWT signed with the .p8 key
 *   (APPLE_PRIVATE_KEY), as Apple requires; it is minted per request.
 * - Identity comes ONLY from the id_token in Apple's token response, and that
 *   token's RS256 signature is checked against Apple's JWKS (cached ~1 h,
 *   refetched once when a kid is unknown), with iss, aud, exp and nonce.
 * - Apple's refresh token is kept only so it can be revoked when the account
 *   is deleted (App Store guideline 5.1.1(v)). It is stored AES-GCM encrypted
 *   under a key derived from SESSION_SECRET, and never logged.
 */
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { b64url, fromB64url, secret } from "./session.js";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_AUTHORIZE = `${APPLE_ISSUER}/auth/authorize`;
const APPLE_TOKEN = `${APPLE_ISSUER}/auth/token`;
const APPLE_KEYS = `${APPLE_ISSUER}/auth/keys`;
const APPLE_REVOKE = `${APPLE_ISSUER}/auth/revoke`;

const TIMEOUT_MS = 10_000;
/** Apple allows up to 6 months; ours lives 5 minutes (one exchange or revoke). */
const CLIENT_SECRET_TTL_S = 300;
const JWKS_CACHE_S = 3600;
const RT_INFO = "tagalong:apple-rt:v1";

export interface AppleConfig {
	servicesId: string;
	teamId: string;
	keyId: string;
	privateKey: string;
}

/** All four settings, or null (sign-in is then "misconfigured": fail closed). */
export function appleConfig(env: Env): AppleConfig | null {
	// wrangler types the vars as the literal "" from wrangler.jsonc; widen them.
	const servicesId = String(env.APPLE_SERVICES_ID ?? "").trim();
	const teamId = String(env.APPLE_TEAM_ID ?? "").trim();
	const keyId = String(env.APPLE_KEY_ID ?? "").trim();
	const privateKey = env.APPLE_PRIVATE_KEY ?? "";
	if (!servicesId || !teamId || !keyId || !privateKey.trim()) return null;
	return { servicesId, teamId, keyId, privateKey };
}

const enc = new TextEncoder();
const b64urlJson = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

// ---------------------------------------------------------------------------
// Client secret (ES256 JWT).
// ---------------------------------------------------------------------------

/**
 * PKCS8 PEM (.p8) to DER. Strips any armour line without spelling one out, so
 * the built bundle never contains a private-key header
 * (scripts/check-bundle-secrets.sh flags that shape).
 */
function pemToDer(pem: string): Uint8Array {
	const b64 = pem
		.replace(/\\n/g, "\n")
		.replace(/-----[A-Z ]+-----/g, "")
		.replace(/\s+/g, "");
	try {
		return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
	} catch {
		throw new HttpError(500, "misconfigured", "Sign in with Apple is not configured.");
	}
}

async function clientSecret(cfg: AppleConfig, nowS = Math.floor(Date.now() / 1000)) {
	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey(
			"pkcs8",
			pemToDer(cfg.privateKey),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["sign"],
		);
	} catch {
		// Never log the key or the import error's detail.
		throw new HttpError(500, "misconfigured", "Sign in with Apple is not configured.");
	}
	const signingInput = `${b64urlJson({ alg: "ES256", kid: cfg.keyId })}.${b64urlJson({
		iss: cfg.teamId,
		iat: nowS,
		exp: nowS + CLIENT_SECRET_TTL_S,
		aud: APPLE_ISSUER,
		sub: cfg.servicesId,
	})}`;
	// WebCrypto ECDSA returns the raw r||s (IEEE P1363) form JWS needs, not DER.
	const sig = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		enc.encode(signingInput),
	);
	return `${signingInput}.${b64url(sig)}`;
}

// ---------------------------------------------------------------------------
// Code exchange.
// ---------------------------------------------------------------------------

const TokenResponse = z.object({
	id_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
});

/** Swaps the authorization code; returns the raw id_token and refresh token. */
export async function exchangeAppleCode(
	cfg: AppleConfig,
	code: string,
	redirectUri: string,
): Promise<z.infer<typeof TokenResponse>> {
	let res: Response;
	try {
		res = await fetch(APPLE_TOKEN, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				client_id: cfg.servicesId,
				client_secret: await clientSecret(cfg),
				code,
				grant_type: "authorization_code",
				redirect_uri: redirectUri,
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(502, "apple_token_failed", "Apple sign-in failed. Try again.");
	}
	if (!res.ok) throw new HttpError(502, "apple_token_failed", "Apple sign-in failed. Try again.");
	const body = TokenResponse.safeParse(await res.json().catch(() => null));
	if (!body.success)
		throw new HttpError(502, "apple_bad_token", "Apple returned no identity token.");
	return body.data;
}

// ---------------------------------------------------------------------------
// id_token verification (RS256 against Apple's JWKS).
// ---------------------------------------------------------------------------

const Jwk = z.object({
	kty: z.literal("RSA"),
	kid: z.string(),
	n: z.string(),
	e: z.string(),
	alg: z.string().optional(),
	use: z.string().optional(),
});
type Jwk = z.infer<typeof Jwk>;
const Jwks = z.object({ keys: z.array(z.unknown()) });

/** Apple's signing keys. Cached in caches.default ~1 h; `fresh` skips the cache. */
async function appleKeys(fresh: boolean): Promise<Jwk[]> {
	const cacheKey = new Request(APPLE_KEYS);
	const cache = typeof caches !== "undefined" ? caches.default : null;
	let body: unknown = null;
	if (!fresh && cache) {
		const hit = await cache.match(cacheKey).catch(() => undefined);
		if (hit) body = await hit.json().catch(() => null);
	}
	if (body === null) {
		let res: Response;
		try {
			res = await fetch(APPLE_KEYS, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch {
			throw new HttpError(502, "apple_keys_failed", "Apple sign-in failed. Try again.");
		}
		if (!res.ok) throw new HttpError(502, "apple_keys_failed", "Apple sign-in failed. Try again.");
		body = await res.json().catch(() => null);
		if (cache && Jwks.safeParse(body).success) {
			await cache
				.put(
					cacheKey,
					new Response(JSON.stringify(body), {
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": `public, max-age=${JWKS_CACHE_S}`,
						},
					}),
				)
				.catch(() => undefined);
		}
	}
	const parsed = Jwks.safeParse(body);
	if (!parsed.success)
		throw new HttpError(502, "apple_keys_failed", "Apple sign-in failed. Try again.");
	// Skip keys we can't use (e.g. a future EC key) rather than failing on them.
	return parsed.data.keys.flatMap((k) => {
		const r = Jwk.safeParse(k);
		return r.success ? [r.data] : [];
	});
}

/** Apple sends these as booleans or as "true"/"false". */
const BoolLike = z.union([z.boolean(), z.enum(["true", "false"])]).transform((v) => v === true || v === "true");

const AppleClaims = z.object({
	iss: z.string(),
	aud: z.union([z.string(), z.array(z.string())]),
	sub: z.string().min(1).max(255),
	exp: z.number(),
	nonce: z.string().optional(),
	email: z.string().email().max(254).optional(),
	email_verified: BoolLike.optional(),
	is_private_email: BoolLike.optional(),
});
export type AppleClaims = z.infer<typeof AppleClaims>;

const badToken = () =>
	new HttpError(401, "apple_bad_token", "That Apple ID could not be verified.");

function decodePart(part: string | undefined): unknown {
	const bytes = part === undefined ? null : fromB64url(part);
	if (!bytes) throw badToken();
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw badToken();
	}
}

function sameString(a: string, b: string): boolean {
	const x = enc.encode(a);
	const y = enc.encode(b);
	return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/**
 * Verifies an Apple id_token: RS256 signature by a current Apple key, issuer,
 * audience (our Services ID), expiry and our nonce. Returns its claims.
 */
export async function verifyAppleIdToken(
	idToken: string,
	audience: string,
	nonce: string,
): Promise<AppleClaims> {
	const parts = idToken.split(".");
	if (parts.length !== 3) throw badToken();
	const [h, p, s] = parts as [string, string, string];
	const header = z
		.object({ alg: z.literal("RS256"), kid: z.string().min(1) })
		.safeParse(decodePart(h));
	if (!header.success) throw badToken();
	const sig = fromB64url(s);
	if (!sig) throw badToken();

	let jwk = (await appleKeys(false)).find((k) => k.kid === header.data.kid);
	if (!jwk) jwk = (await appleKeys(true)).find((k) => k.kid === header.data.kid);
	if (!jwk) throw badToken();

	let ok = false;
	try {
		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, enc.encode(`${h}.${p}`));
	} catch {
		ok = false;
	}
	if (!ok) throw badToken();

	const claims = AppleClaims.safeParse(decodePart(p));
	if (!claims.success) throw badToken();
	const c = claims.data;
	const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
	if (
		c.iss !== APPLE_ISSUER ||
		!auds.includes(audience) ||
		c.exp * 1000 < Date.now() ||
		c.nonce === undefined ||
		!sameString(c.nonce, nonce)
	)
		throw badToken();
	return c;
}

// ---------------------------------------------------------------------------
// Refresh token at rest: AES-GCM, key = HKDF-SHA256(SESSION_SECRET, info).
// Stored as base64url(iv) "." base64url(ciphertext+tag).
// ---------------------------------------------------------------------------

async function rtKey(env: Env): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", enc.encode(secret(env)), "HKDF", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(RT_INFO) },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptRefreshToken(env: Env, token: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await rtKey(env), enc.encode(token));
	return `${b64url(iv)}.${b64url(ct)}`;
}

/** The plaintext token, or null if the value is malformed or doesn't decrypt (e.g. a rotated secret). */
export async function decryptRefreshToken(env: Env, stored: string): Promise<string | null> {
	const [ivPart, ctPart, extra] = stored.split(".");
	if (extra !== undefined || !ivPart || !ctPart) return null;
	const iv = fromB64url(ivPart);
	const ct = fromB64url(ctPart);
	if (!iv || iv.length !== 12 || !ct) return null;
	try {
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await rtKey(env), ct);
		return new TextDecoder().decode(pt);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Revocation (account deletion).
// ---------------------------------------------------------------------------

/**
 * Revokes an Apple refresh token. Best effort: returns whether Apple accepted
 * it, never throws, and never logs the token or the client secret.
 */
export async function revokeApple(env: Env, refreshToken: string): Promise<boolean> {
	try {
		const cfg = appleConfig(env);
		if (!cfg) return false;
		const res = await fetch(APPLE_REVOKE, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: cfg.servicesId,
				client_secret: await clientSecret(cfg),
				token: refreshToken,
				token_type_hint: "refresh_token",
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return res.ok;
	} catch {
		return false;
	}
}
