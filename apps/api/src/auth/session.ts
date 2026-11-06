import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { HttpError, type AppEnv } from "../lib/http.js";

export const SESSION_COOKIE = "tg_session";
const SESSION_DAYS = 30;

function secret(env: Env): string {
	if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
		// Fail closed: a missing or short secret must never mean "unsigned".
		throw new HttpError(500, "misconfigured", "Sign-in is not configured.");
	}
	return env.SESSION_SECRET;
}

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

export async function sessionUserId(c: Context<AppEnv>): Promise<string | null> {
	const raw = await getSignedCookie(c, secret(c.env), SESSION_COOKIE);
	if (!raw) return null;
	const dot = raw.lastIndexOf(".");
	const userId = raw.slice(0, dot);
	const exp = Number(raw.slice(dot + 1));
	if (dot <= 0 || !Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
	return userId;
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
	const userId = await sessionUserId(c);
	if (!userId) throw new HttpError(401, "signed_out", "Sign in first.");
	const row = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?")
		.bind(userId)
		.first<{ id: string }>();
	if (!row) throw new HttpError(401, "signed_out", "Sign in first.");
	c.set("userId", userId);
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
