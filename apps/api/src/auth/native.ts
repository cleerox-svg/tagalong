/**
 * Phase 6: native (Capacitor) sign-in. Google blocks OAuth in embedded
 * webviews and the app's webview is cross-site to the API, so the app opens
 * /auth/google/start?native=1&code_challenge=... (or /auth/apple/start) in the
 * system browser. The callback hands a one-time code back to the app on a
 * FIXED verified HTTPS link (an Android App Link / iOS Universal Link on the
 * web origin, phase 7), and the app swaps code + PKCE verifier for a bearer
 * token here.
 *
 * Only SHA-256(code) is stored (base64url), the code lives 60 s and is
 * single-use (one atomic UPDATE ... RETURNING); a failed PKCE check still
 * burns it.
 */
import { NativeAuthExchangeSchema } from "@tagalong/shared";
import { Hono } from "hono";
import { HttpError, nowIso, readJson, type AppEnv } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { assertJsonBody } from "../lib/security.js";
import { assertUserExists, b64url, issueBearer } from "./session.js";

/**
 * The ONLY place a native sign-in redirects to. Never a client-supplied URL.
 * A verified HTTPS link (phase 7): the OS hands it only to the app whose
 * signature the domain vouches for (/.well-known/assetlinks.json,
 * /.well-known/apple-app-site-association on tagalong.averrow.com), unlike a
 * custom scheme, which any installed app can claim.
 */
export const NATIVE_CALLBACK = "https://tagalong.averrow.com/auth/app-callback";

/** RFC 7636 S256 challenge: base64url SHA-256, unpadded, always 43 chars. */
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

const CODE_TTL_SECONDS = 60;

export const nativeRedirect = (q: { code: string } | { error: string }) =>
	`${NATIVE_CALLBACK}?${new URLSearchParams(q)}`;

const sha256b64url = async (s: string) =>
	b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** Mints a one-time code for `userId`, stores its hash with the challenge, returns the code. */
export async function issueNativeCode(
	db: D1Database,
	userId: string,
	codeChallenge: string,
): Promise<string> {
	const code = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();
	await db
		.prepare(
			`INSERT INTO native_auth_codes (code_hash, user_id, code_challenge, expires_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(await sha256b64url(code), userId, codeChallenge, expiresAt)
		.run();
	return code;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	// Lengths are public (a challenge is always 43 chars); compare contents in constant time.
	return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export const native = new Hono<AppEnv>();

/**
 * POST /auth/native/exchange {code, code_verifier} → {token, expires_at}.
 * No cookie is read or set; there is no ambient credential, so no Origin
 * check. Every failure is the same 400.
 */
native.post("/auth/native/exchange", async (c) => {
	const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
	await rateLimit(c.env.DB, `native-exchange:${ip}`, 20, 60);
	assertJsonBody(c.req.header("Content-Type"));
	const invalid = new HttpError(400, "invalid_code", "Sign-in failed. Try again.");

	const body = NativeAuthExchangeSchema.safeParse(await readJson(c));
	if (!body.success) throw invalid;
	const now = nowIso();
	const row = await c.env.DB.prepare(
		`UPDATE native_auth_codes SET used_at = ?
		 WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
		 RETURNING user_id, code_challenge`,
	)
		.bind(now, await sha256b64url(body.data.code), now)
		.first<{ user_id: string; code_challenge: string }>();
	if (!row) throw invalid;
	if (!timingSafeEqualStr(await sha256b64url(body.data.code_verifier), row.code_challenge))
		throw invalid;
	try {
		await assertUserExists(c.env.DB, row.user_id);
	} catch {
		throw invalid;
	}

	// Housekeeping: drop a bounded batch of codes that expired over an hour ago.
	c.executionCtx.waitUntil(
		c.env.DB.prepare(
			`DELETE FROM native_auth_codes WHERE code_hash IN
			   (SELECT code_hash FROM native_auth_codes WHERE expires_at < ? LIMIT 100)`,
		)
			.bind(new Date(Date.now() - 3600_000).toISOString())
			.run()
			.catch((err) => console.error("native code cleanup failed", err)),
	);

	return c.json(await issueBearer(c.env, row.user_id));
});
