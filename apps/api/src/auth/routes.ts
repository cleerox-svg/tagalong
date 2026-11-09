import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import {
	AppleFirstSignInUserSchema,
	appleDisplayName,
	isCurrencyCode,
	type AuthProvider,
} from "@tagalong/shared";
import { z } from "zod";
import { HttpError, newId, nowIso, readJson, type AppEnv } from "../lib/http.js";
import { requireTrustedWrite, WEB_ORIGINS } from "../lib/security.js";
import {
	isModerator,
	TAGALONG_COLUMNS,
	tagalongStatus,
	type TagalongRow,
} from "../tagalong/access.js";
import {
	APPLE_AUTHORIZE,
	appleConfig,
	encryptRefreshToken,
	exchangeAppleCode,
	verifyAppleIdToken,
} from "./apple.js";
import {
	CODE_CHALLENGE_RE,
	issueNativeCode,
	native,
	nativeRedirect,
	timingSafeEqualStr,
} from "./native.js";
import { endSession, requireUser, secret, startSession } from "./session.js";

const OAUTH_COOKIE = "tg_oauth";
/**
 * Apple's own state cookie (phase 7). Apple's callback is a cross-site POST
 * (response_mode=form_post), which a SameSite=Lax cookie would not ride on, so
 * this one is SameSite=None; Secure, scoped to /auth/apple, 10 minutes, and
 * deleted on use. tg_oauth (Google) is untouched.
 */
const APPLE_COOKIE = "tg_oauth_apple";
const APPLE_COOKIE_PATH = "/auth/apple";
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

/**
 * Native flows' `state` starts with this, so a callback whose tg_oauth cookie
 * was lost or expired still ends on NATIVE_CALLBACK (with error=bad_state)
 * instead of a JSON page the app never sees. Web states are bare UUIDs.
 */
const NATIVE_STATE_PREFIX = "n.";

auth.get("/auth/google/start", async (c) => {
	if (!c.env.GOOGLE_CLIENT_ID)
		throw new HttpError(500, "misconfigured", "Sign-in is not configured.");
	const isNative = c.req.query("native") === "1";
	const state = isNative ? `${NATIVE_STATE_PREFIX}${newId()}` : newId();
	const saved: OAuthState = { state, returnTo: safeReturn(c.req.query("return_to")) };
	if (isNative) {
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

/** Swaps Google's code for a verified identity and upserts the user. Returns our user id and email. */
async function googleUser(c: Context<AppEnv>, code: string): Promise<SignedInUser> {
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
	return { id: user.id, label: email };
}

const escapeHtml = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
	);

/**
 * Interim (security review M1): any installed app can register the custom
 * scheme, so a successful native sign-in first shows who signed in and asks
 * the user to tap through, instead of redirecting silently. The link is always
 * nativeRedirect (the fixed NATIVE_CALLBACK); nothing from the request is in
 * it. Before store release NATIVE_CALLBACK becomes a verified HTTPS App Link /
 * Universal Link (docs/SETUP.md, "Mobile sign-in").
 */
function nativeInterstitial(c: Context<AppEnv>, email: string, appCode: string): Response {
	const href = escapeHtml(nativeRedirect({ code: appCode }));
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Return to Budgetrip</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#111}
a.button{display:inline-block;padding:.75rem 1.25rem;border-radius:.5rem;background:#0b5fff;color:#fff;text-decoration:none;font-weight:600}
p.note{color:#555;font-size:.9rem}
</style>
</head>
<body>
<h1>Signed in as ${escapeHtml(email)}</h1>
<p><a class="button" href="${href}">Return to Budgetrip</a></p>
<p class="note">If you didn't start signing in to the Budgetrip app, close this page.</p>
</body>
</html>
`;
	return c.html(html, 200, {
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
		"X-Frame-Options": "DENY",
		"X-Content-Type-Options": "nosniff",
	});
}

/** Who a provider signed in: our user id and what to show as "Signed in as". */
interface SignedInUser {
	id: string;
	label: string;
}

/**
 * The end of every provider's callback, once its state check passed.
 * Native: resolve the user, mint a one-time app code and show the interstitial;
 * any failure goes back to the app's fixed URL as a short error code (the web
 * session cookie is never set on this path). Web: start the cookie session and
 * redirect to the (already validated) returnTo with `webStatus` (Google's GET
 * callback keeps 302; Apple's POST callback uses 303 so the browser GETs).
 */
async function completeSignIn(
	c: Context<AppEnv>,
	saved: OAuthState,
	resolveUser: () => Promise<SignedInUser>,
	webStatus: 302 | 303,
): Promise<Response> {
	if (saved.native && saved.codeChallenge) {
		try {
			const user = await resolveUser();
			const appCode = await issueNativeCode(c.env.DB, user.id, saved.codeChallenge);
			return nativeInterstitial(c, user.label, appCode);
		} catch (err) {
			if (!(err instanceof HttpError)) console.error("native sign-in failed", err);
			const error = err instanceof HttpError ? err.code : "internal";
			return c.redirect(nativeRedirect({ error }), webStatus);
		}
	}
	await startSession(c, (await resolveUser()).id);
	return c.redirect(saved.returnTo, webStatus);
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
		if (!state || state !== saved.state)
			return c.redirect(nativeRedirect({ error: "bad_state" }), 302);
		if (!code) return c.redirect(nativeRedirect({ error: "cancelled" }), 302);
		return completeSignIn(c, saved, () => googleUser(c, code), 302);
	}

	// A native flow whose cookie was lost: back to the app (fixed URL), not JSON.
	if (!saved?.native && state?.startsWith(NATIVE_STATE_PREFIX))
		return c.redirect(nativeRedirect({ error: "bad_state" }), 302);
	if (!saved || !state || state !== saved.state) {
		throw new HttpError(400, "bad_state", "Sign-in expired or was started elsewhere. Try again.");
	}
	if (!code) return c.redirect(saved.returnTo, 302); // the user cancelled at Google
	return completeSignIn(c, saved, () => googleUser(c, code), 302);
});

// ---------------------------------------------------------------------------
// Sign in with Apple (phase 7). Protocol details are in ./apple.ts.
// ---------------------------------------------------------------------------

/** tg_oauth_apple: as OAuthState, plus the OpenID nonce the id_token must echo. */
type AppleOAuthState = OAuthState & { nonce: string };

const appleRedirectUri = (url: string) => `${new URL(url).origin}/auth/apple/callback`;

const appleCookieOpts = {
	httpOnly: true,
	secure: true,
	sameSite: "None",
	path: APPLE_COOKIE_PATH,
} as const;

auth.get("/auth/apple/start", async (c) => {
	const isNative = c.req.query("native") === "1";
	const cfg = appleConfig(c.env);
	if (!cfg || !c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 32) {
		if (isNative) return c.redirect(nativeRedirect({ error: "misconfigured" }), 302);
		throw new HttpError(500, "misconfigured", "Sign in with Apple is not configured.");
	}
	const state = isNative ? `${NATIVE_STATE_PREFIX}${newId()}` : newId();
	const saved: AppleOAuthState = {
		state,
		nonce: newId(),
		returnTo: safeReturn(c.req.query("return_to")),
	};
	if (isNative) {
		const challenge = c.req.query("code_challenge") ?? "";
		if (!CODE_CHALLENGE_RE.test(challenge))
			return c.redirect(nativeRedirect({ error: "bad_request" }), 302);
		saved.native = true;
		saved.codeChallenge = challenge;
	}
	await setSignedCookie(c, APPLE_COOKIE, JSON.stringify(saved), secret(c.env), {
		...appleCookieOpts,
		maxAge: 600,
	});
	const q = new URLSearchParams({
		client_id: cfg.servicesId,
		redirect_uri: appleRedirectUri(c.req.url),
		response_type: "code",
		response_mode: "form_post",
		scope: "name email",
		state,
		nonce: saved.nonce,
	});
	return c.redirect(`${APPLE_AUTHORIZE}?${q}`, 302);
});

/** A form field as a string (Apple posts urlencoded fields), else undefined. */
const field = (v: unknown): string | undefined =>
	typeof v === "string" && v.length > 0 ? v : undefined;

function parseAppleState(raw: string | false | undefined): AppleOAuthState | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as Partial<AppleOAuthState>;
		return typeof v.state === "string" &&
			typeof v.nonce === "string" &&
			typeof v.returnTo === "string"
			? (v as AppleOAuthState)
			: null;
	} catch {
		return null;
	}
}

/**
 * Apple's first-sign-in `user` JSON (name, email). Unsigned, so only ever a
 * display-name hint for a NEW account; the email always comes from the
 * verified id_token.
 */
function appleNameHint(raw: string | undefined): string | null {
	if (!raw || raw.length > 2000) return null;
	try {
		const parsed = AppleFirstSignInUserSchema.safeParse(JSON.parse(raw));
		return parsed.success ? appleDisplayName(parsed.data) : null;
	} catch {
		return null;
	}
}

/**
 * Swaps Apple's code for a verified identity and upserts the user by
 * apple_sub. Returns our user id and something to show as "Signed in as".
 *
 * No automatic linking to an existing Google account with the same email:
 * Apple's email is often a private relay address, and where it isn't, an
 * email match is not proof that the same person controls both accounts
 * (linking on it would let whoever controls one sign-in take over the other).
 * An Apple sign-in therefore always has its own account.
 *
 * New accounts get google_sub = 'apple:' || sub (google_sub is NOT NULL
 * UNIQUE; migration 0009). The name hint is used on INSERT only. A row whose
 * deleted_at is set is never signed in to (the conflict UPDATE's WHERE skips
 * it, so nothing comes back); in practice deletion clears apple_sub, so the
 * same Apple ID simply gets a fresh account.
 */
async function appleUser(
	c: Context<AppEnv>,
	code: string,
	nonce: string,
	userJson: string | undefined,
): Promise<SignedInUser> {
	const cfg = appleConfig(c.env);
	if (!cfg) throw new HttpError(500, "misconfigured", "Sign in with Apple is not configured.");
	const tokens = await exchangeAppleCode(cfg, code, appleRedirectUri(c.req.url));
	const claims = await verifyAppleIdToken(tokens.id_token, cfg.servicesId, nonce);
	// Apple vouches for the address it puts in the id_token (a real one or a
	// private relay); an unverified one is not stored.
	const email = claims.email && claims.email_verified !== false ? claims.email : "";
	const rtEnc = tokens.refresh_token
		? await encryptRefreshToken(c.env, tokens.refresh_token)
		: null;
	const user = await c.env.DB.prepare(
		`INSERT INTO users (id, google_sub, apple_sub, email, display_name, apple_refresh_token_enc)
		 VALUES (?1, 'apple:' || ?2, ?2, ?3, ?4, ?5)
		 ON CONFLICT (apple_sub) DO UPDATE SET
		   email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE users.email END,
		   apple_refresh_token_enc = COALESCE(excluded.apple_refresh_token_enc, users.apple_refresh_token_enc)
		 WHERE users.deleted_at IS NULL
		 RETURNING id, email, display_name`,
	)
		.bind(newId(), claims.sub, email, appleNameHint(userJson) ?? "Traveller", rtEnc)
		.first<{ id: string; email: string; display_name: string }>();
	if (!user) throw new HttpError(401, "account_deleted", "That account has been deleted.");
	return { id: user.id, label: user.email || user.display_name };
}

/**
 * Apple's callback: a cross-site form POST from appleid.apple.com
 * (response_mode=form_post). Deliberately NOT behind requireTrustedWrite (its
 * Origin is Apple's, and its body is a form): it is the only write route
 * without it. What protects it instead: the state must match the signed,
 * single-use tg_oauth_apple cookie (constant-time), and the id_token must
 * carry that flow's nonce. It never reads or trusts the session cookie.
 */
auth.post("/auth/apple/callback", async (c) => {
	const raw = await getSignedCookie(c, secret(c.env), APPLE_COOKIE);
	deleteCookie(c, APPLE_COOKIE, appleCookieOpts);
	const saved = parseAppleState(raw);

	let form: Record<string, unknown> = {};
	try {
		form = await c.req.parseBody();
	} catch {
		form = {};
	}
	const state = field(form.state);
	const code = field(form.code);
	const error = field(form.error);
	const stateOk = !!saved && !!state && timingSafeEqualStr(state, saved.state);

	if (saved?.native && saved.codeChallenge) {
		if (!stateOk) return c.redirect(nativeRedirect({ error: "bad_state" }), 303);
		if (error || !code) return c.redirect(nativeRedirect({ error: "cancelled" }), 303);
		return completeSignIn(c, saved, () => appleUser(c, code, saved.nonce, field(form.user)), 303);
	}
	if (!saved?.native && state?.startsWith(NATIVE_STATE_PREFIX))
		return c.redirect(nativeRedirect({ error: "bad_state" }), 303);
	if (!saved || !stateOk) {
		throw new HttpError(400, "bad_state", "Sign-in expired or was started elsewhere. Try again.");
	}
	if (error || !code) return c.redirect(saved.returnTo, 303); // the user cancelled at Apple
	return completeSignIn(c, saved, () => appleUser(c, code, saved.nonce, field(form.user)), 303);
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
