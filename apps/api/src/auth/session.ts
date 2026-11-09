import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { HttpError, type AppEnv } from "../lib/http.js";
import { hasBearer } from "../lib/security.js";

export const SESSION_COOKIE = "tg_session";
export const SESSION_DAYS = 30;

export function secret(env: Env): string {
	if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
		// Fail closed: a missing or short secret must never mean "unsigned".
		throw new HttpError(500, "misconfigured", "Sign-in is not configured.");
	}
	return env.SESSION_SECRET;
}

// ---------------------------------------------------------------------------
// Signed tokens (bearer sessions, chat tickets). `<payload>.<sig>`, where sig
// is base64url HMAC-SHA256(SESSION_SECRET, `<label>\n<payload>`). The label
// separates token kinds: a bearer token is not a chat ticket, and neither is a
// cookie value (hono signs cookies with no label and standard base64).
// ---------------------------------------------------------------------------

export const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

const fromB64url = (s: string): Uint8Array | null => {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
	try {
		const b64 = s
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(s.length / 4) * 4, "=");
		return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
	} catch {
		return null;
	}
};

const hmacKey = (env: Env) =>
	crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret(env)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);

export async function signToken(env: Env, label: string, payload: string): Promise<string> {
	const sig = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(env),
		new TextEncoder().encode(`${label}\n${payload}`),
	);
	return `${payload}.${b64url(sig)}`;
}

/** The payload if the signature is valid for `label`, else null. Constant-time (subtle.verify). */
export async function verifyToken(env: Env, label: string, token: string): Promise<string | null> {
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return null;
	const payload = token.slice(0, dot);
	const sig = fromB64url(token.slice(dot + 1));
	if (!sig || sig.length !== 32) return null;
	const ok = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(env),
		sig,
		new TextEncoder().encode(`${label}\n${payload}`),
	);
	return ok ? payload : null;
}

// ---------------------------------------------------------------------------
// Cookie session (the web app).
// ---------------------------------------------------------------------------

const cookieOpts = (c: Context) => ({
	httpOnly: true,
	// Plain http only in local dev (wrangler dev on localhost).
	secure: new URL(c.req.url).protocol === "https:",
	sameSite: "Lax" as const,
	path: "/",
	// Host-only on the API's own hostname; the web app is same-site, so its
	// credentialed fetches carry it.
	maxAge: SESSION_DAYS * 86400,
});

/** Cookie value: `<userId>.<expiresEpochSeconds>`, HMAC-signed by hono. */
export async function startSession(c: Context<AppEnv>, userId: string): Promise<void> {
	const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
	await setSignedCookie(c, SESSION_COOKIE, `${userId}.${exp}`, secret(c.env), cookieOpts(c));
}

export function endSession(c: Context<AppEnv>): void {
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** `<userId>.<exp>` → userId if well-formed and not expired. */
function parseUserExp(raw: string): string | null {
	const dot = raw.lastIndexOf(".");
	const userId = raw.slice(0, dot);
	const exp = Number(raw.slice(dot + 1));
	if (dot <= 0 || !Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
	return userId;
}

// ---------------------------------------------------------------------------
// Bearer session (the native app). `b1.<userId>.<exp>.<sig>`, label below.
// ---------------------------------------------------------------------------

const BEARER_LABEL = "tagalong:bearer:v1";
const BEARER_PREFIX = "b1.";

export async function issueBearer(
	env: Env,
	userId: string,
): Promise<{ token: string; expires_at: string }> {
	const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
	const token = await signToken(env, BEARER_LABEL, `${BEARER_PREFIX}${userId}.${exp}`);
	return { token, expires_at: new Date(exp * 1000).toISOString() };
}

async function bearerUserId(env: Env, authorization: string): Promise<string | null> {
	const m = /^Bearer ([A-Za-z0-9._~-]{1,512})$/i.exec(authorization);
	if (!m?.[1]) return null;
	const payload = await verifyToken(env, BEARER_LABEL, m[1]);
	if (!payload?.startsWith(BEARER_PREFIX)) return null;
	return parseUserExp(payload.slice(BEARER_PREFIX.length));
}

/**
 * The signed-in user id, or null. If an Authorization header is present it is
 * the ONLY credential considered (a bad one never falls back to the cookie);
 * otherwise the session cookie as before.
 */
export async function sessionUserId<E extends AppEnv>(c: Context<E>): Promise<string | null> {
	const authorization = c.req.header("Authorization");
	if (authorization !== undefined) {
		return hasBearer(authorization) ? bearerUserId(c.env, authorization) : null;
	}
	const raw = await getSignedCookie(c, secret(c.env), SESSION_COOKIE);
	return raw ? parseUserExp(raw) : null;
}

/** 401 unless the account still exists. */
export async function assertUserExists(db: D1Database, userId: string): Promise<void> {
	const row = await db.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
	if (!row) throw new HttpError(401, "signed_out", "Sign in first.");
}

/** The signed-in user's id (bearer or cookie, see sessionUserId) for an existing account; else 401. */
export async function authenticate<E extends AppEnv>(c: Context<E>): Promise<string> {
	const userId = await sessionUserId(c);
	if (!userId) throw new HttpError(401, "signed_out", "Sign in first.");
	await assertUserExists(c.env.DB, userId);
	return userId;
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
	c.set("userId", await authenticate(c));
	return next();
});

/** Spec §6: 18+ only, confirmed at sign-up. Planning requires it too. */
export const requireAdult = createMiddleware<AppEnv>(async (c, next) => {
	const row = await c.env.DB.prepare("SELECT birthdate_verified_18 AS ok FROM users WHERE id = ?")
		.bind(c.get("userId"))
		.first<{ ok: number }>();
	if (row?.ok !== 1)
		throw new HttpError(403, "age_unconfirmed", "Confirm you are 18 or older first.");
	return next();
});
