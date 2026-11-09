import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { isCurrencyCode } from "@tagalong/shared";
import { z } from "zod";
import { HttpError, newId, nowIso, readJson, type AppEnv } from "../lib/http.js";
import { requireTrustedWrite, WEB_ORIGINS } from "../lib/security.js";
import {
	isModerator,
	TAGALONG_COLUMNS,
	tagalongStatus,
	type TagalongRow,
} from "../tagalong/access.js";
import { CODE_CHALLENGE_RE, issueNativeCode, native, nativeRedirect } from "./native.js";
import { endSession, requireUser, startSession } from "./session.js";

const OAUTH_COOKIE = "tg_oauth";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

export const auth = new Hono<AppEnv>();

// POST /auth/native/exchange (phase 6, native sign-in).
auth.route("/", native);

/** Where to send the browser after sign-in. Only our own web origins. */
function safeReturn(raw: string | undefined): string {
	const fallback = `${WEB_ORIGINS[0]}/`;
	if (!raw) return fallback;
	try {
		const u = new URL(raw);
		return WEB_ORIGINS.includes(u.origin) ? u.toString() : fallback;
	} catch {
		return fallback;
	}
}

const redirectUri = (url: string) => `${new URL(url).origin}/auth/google/callback`;

/**
 * Signed tg_oauth cookie. `native` sign-ins (phase 6) also carry the app's
 * PKCE S256 challenge; they end on NATIVE_CALLBACK, never on returnTo.
 */
type OAuthState = { state: string; returnTo: string; native?: true; codeChallenge?: string };

auth.get("/auth/google/start", async (c) => {
	if (!c.env.GOOGLE_CLIENT_ID)
		throw new HttpError(500, "misconfigured", "Sign-in is not configured.");
	const state = newId();
	const saved: OAuthState = { state, returnTo: safeReturn(c.req.query("return_to")) };
	if (c.req.query("native") === "1") {
		const challenge = c.req.query("code_challenge") ?? "";
		if (!CODE_CHALLENGE_RE.test(challenge))
			return c.redirect(nativeRedirect({ error: "bad_request" }), 302);
		saved.native = true;
		saved.codeChallenge = challenge;
	}
	await setSignedCookie(c, OAUTH_COOKIE, JSON.stringify(saved), c.env.SESSION_SECRET, {
		httpOnly: true,
		secure: new URL(c.req.url).protocol === "https:",
		sameSite: "Lax",
		path: "/auth",
		maxAge: 600,
	});
	const q = new URLSearchParams({
		client_id: c.env.GOOGLE_CLIENT_ID,
		redirect_uri: redirectUri(c.req.url),
		response_type: "code",
		scope: "openid email profile",
		state,
		prompt: "select_account",
	});
	return c.redirect(`${GOOGLE_AUTH}?${q}`, 302);
});

const IdTokenClaims = z.object({
	iss: z.string(),
	aud: z.string(),
	sub: z.string().min(1),
	exp: z.number(),
	email: z.string().email(),
	email_verified: z.boolean(),
	name: z.string().optional(),
});

function decodeJwtPayload(jwt: string): unknown {
	const part = jwt.split(".")[1];
	if (!part)
		throw new HttpError(502, "google_bad_token", "Google returned an unreadable sign-in token.");
	const b64 = part
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(part.length / 4) * 4, "=");
	return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
}

/** Swaps Google's code for a verified identity and upserts the user. Returns our user id. */
async function googleUser(c: Context<AppEnv>, code: string): Promise<string> {
	const tokenRes = await fetch(GOOGLE_TOKEN, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: c.env.GOOGLE_CLIENT_ID,
			client_secret: c.env.GOOGLE_CLIENT_SECRET,
			redirect_uri: redirectUri(c.req.url),
			grant_type: "authorization_code",
		}),
	});
	if (!tokenRes.ok)
		throw new HttpError(502, "google_token_failed", "Google sign-in failed. Try again.");
	const token = (await tokenRes.json()) as { id_token?: string };
	if (!token.id_token)
		throw new HttpError(502, "google_bad_token", "Google returned no identity token.");

	// The ID token came straight from Google's token endpoint over TLS in
	// exchange for our client secret, so its signature need not be re-checked
	// (OpenID Connect Core §3.1.3.7). Its claims still are.
	const claims = IdTokenClaims.safeParse(decodeJwtPayload(token.id_token));
	if (
		!claims.success ||
		!GOOGLE_ISSUERS.includes(claims.data.iss) ||
		claims.data.aud !== c.env.GOOGLE_CLIENT_ID ||
		claims.data.exp * 1000 < Date.now() ||
		!claims.data.email_verified
	) {
		throw new HttpError(401, "google_bad_token", "That Google account could not be verified.");
	}

	const { sub, email, name } = claims.data;
	const user = await c.env.DB.prepare(
		`INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, ?)
		 ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email
		 RETURNING id`,
	)
		.bind(newId(), sub, email, (name ?? email.split("@")[0] ?? "Traveller").slice(0, 80))
		.first<{ id: string }>();
	if (!user) throw new HttpError(500, "internal", "Could not save your account.");
	return user.id;
}

auth.get("/auth/google/callback", async (c) => {
	const raw = await getSignedCookie(c, c.env.SESSION_SECRET, OAUTH_COOKIE);
	deleteCookie(c, OAUTH_COOKIE, { path: "/auth" });
	const saved = raw ? (JSON.parse(raw) as OAuthState) : null;
	const state = c.req.query("state");
	const code = c.req.query("code");

	if (saved?.native && saved.codeChallenge) {
		// Native: always back to the app's fixed URL, with a code or a short error.
		// The web session cookie is never set on this path.
		const challenge = saved.codeChallenge;
		if (!state || state !== saved.state)
			return c.redirect(nativeRedirect({ error: "bad_state" }), 302);
		if (!code) return c.redirect(nativeRedirect({ error: "cancelled" }), 302);
		try {
			const userId = await googleUser(c, code);
			const appCode = await issueNativeCode(c.env.DB, userId, challenge);
			return c.redirect(nativeRedirect({ code: appCode }), 302);
		} catch (err) {
			if (!(err instanceof HttpError)) console.error("native sign-in failed", err);
			const error = err instanceof HttpError ? err.code : "internal";
			return c.redirect(nativeRedirect({ error }), 302);
		}
	}

	if (!saved || !state || state !== saved.state) {
		throw new HttpError(400, "bad_state", "Sign-in expired or was started elsewhere. Try again.");
	}
	if (!code) return c.redirect(saved.returnTo, 302); // the user cancelled at Google
	await startSession(c, await googleUser(c, code));
	return c.redirect(saved.returnTo, 302);
});

auth.post("/auth/logout", requireTrustedWrite, (c) => {
	endSession(c);
	return c.json({ ok: true });
});

auth.get("/me", requireUser, async (c) => {
	const me = await c.env.DB.prepare(
		`SELECT id, email, display_name, home_city, home_currency, birthdate_verified_18,
		   ${TAGALONG_COLUMNS}
		 FROM users WHERE id = ?`,
	)
		.bind(c.get("userId"))
		.first<
			{
				id: string;
				email: string;
				display_name: string;
				home_city: string | null;
				home_currency: string | null;
				birthdate_verified_18: number;
			} & TagalongRow
		>();
	if (!me) throw new HttpError(401, "signed_out", "Sign in first.");
	// The user's own account: email and home city are theirs to see. Tagalong
	// shows others only the name and city in `tagalong`.
	return c.json({
		id: me.id,
		email: me.email,
		display_name: me.display_name,
		home_city: me.home_city,
		home_currency: me.home_currency,
		birthdate_verified_18: me.birthdate_verified_18 === 1,
		tagalong: tagalongStatus(me),
		is_moderator: isModerator(c.env, me.id),
	});
});

const Onboarding = z.object({
	confirm_18_or_older: z.literal(true),
	home_currency: z.string().refine(isCurrencyCode, "ISO 4217 code"),
	home_city: z.string().trim().min(1).max(100).optional(),
});

/**
 * One-time sign-up step: the 18+ self-declaration (open decision §10.3 — a
 * stronger check may replace it before Tagalong launches) and the currency
 * budgets default to.
 */
auth.post("/me/onboarding", requireTrustedWrite, requireUser, async (c) => {
	const body = Onboarding.safeParse(await readJson(c));
	if (!body.success)
		throw new HttpError(
			400,
			"invalid",
			"Confirm you are 18 or older and pick a currency.",
			body.error.issues,
		);
	await c.env.DB.prepare(
		`UPDATE users SET birthdate_verified_18 = 1, age_confirmed_at = COALESCE(age_confirmed_at, ?),
		 home_currency = ?, home_city = COALESCE(?, home_city) WHERE id = ?`,
	)
		.bind(nowIso(), body.data.home_currency, body.data.home_city ?? null, c.get("userId"))
		.run();
	return c.json({ ok: true });
});
