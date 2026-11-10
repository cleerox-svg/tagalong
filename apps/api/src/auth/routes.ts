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
import { rateLimit } from "../lib/rate-limit.js";
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
import { identityHash, isRealGoogleSub, SUSPENDED_AT_FOR_HASH } from "./suspended-identity.js";

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

/** Sign-in requests per IP per minute, per endpoint (start and callback, each provider). */
const SIGN_IN_LIMIT = 20;

/**
 * Per-IP limit on a sign-in endpoint. Web: throws the 429. Native: returns the
 * error interstitial (error=rate_limited), since the app only ever sees the
 * fixed callback URL. Null when under the limit.
 *
 * Keyed on CF-Connecting-IP, which Cloudflare's edge sets (and overwrites) on
 * every request that reaches the Worker, so a client can neither omit nor
 * spoof it. Only in-process calls (the test suite) arrive without it; those
 * are not limited, rather than all sharing one "unknown" bucket.
 */
async function signInLimit(
	c: Context<AppEnv>,
	endpoint: string,
	isNative: boolean,
): Promise<Response | null> {
	const ip = c.req.header("CF-Connecting-IP");
	if (!ip) return null;
	try {
		await rateLimit(c.env.DB, `signin:${endpoint}:${ip}`, SIGN_IN_LIMIT, 60);
		return null;
	} catch (err) {
		if (isNative && err instanceof HttpError && err.code === "rate_limited")
			return nativeErrorPage(c, "rate_limited");
		throw err;
	}
}

auth.get("/auth/google/start", async (c) => {
	const isNative = c.req.query("native") === "1";
	const limited = await signInLimit(c, "google-start", isNative);
	if (limited) return limited;
	if (!c.env.GOOGLE_CLIENT_ID)
		throw new HttpError(500, "misconfigured", "Sign-in is not configured.");
	const state = isNative ? `${NATIVE_STATE_PREFIX}${newId()}` : newId();
	const saved: OAuthState = { state, returnTo: safeReturn(c.req.query("return_to")) };
	if (isNative) {
		const challenge = c.req.query("code_challenge") ?? "";
		if (!CODE_CHALLENGE_RE.test(challenge)) return nativeErrorPage(c, "bad_request");
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
	// A new row inherits a suspension kept from a deleted account with the same
	// identity (suspended_identities); the conflict UPDATE never touches it.
	const user = await c.env.DB.prepare(
		`INSERT INTO users (id, google_sub, email, display_name, tagalong_suspended_at)
		 VALUES (?, ?, ?, ?, ${SUSPENDED_AT_FOR_HASH})
		 ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email
		 RETURNING id`,
	)
		.bind(
			newId(),
			sub,
			email,
			(name ?? email.split("@")[0] ?? "Traveller").slice(0, 80),
			await identityHash(c.env, "google", sub),
		)
		.first<{ id: string }>();
	if (!user) throw new HttpError(500, "internal", "Could not save your account.");
	return { id: user.id, label: email };
}

const escapeHtml = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
	);

/** Strict headers for the native interstitials: a static page, nothing to load. */
const INTERSTITIAL_HEADERS = {
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
} as const;

/** Both interstitials: one heading, one message, one button to `href` (already escaped). */
function interstitialHtml(o: {
	title: string;
	heading: string;
	body: string;
	href: string;
	button: string;
}) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#111}
a.button{display:inline-block;padding:.75rem 1.25rem;border-radius:.5rem;background:#0f766e;color:#fff;text-decoration:none;font-weight:600}
p.note{color:#555;font-size:.9rem}
</style>
</head>
<body>
<h1>${o.heading}</h1>
${o.body}<p><a class="button" href="${o.href}">${o.button}</a></p>
<p class="note">If the app doesn't open, make sure Budgetrip is installed, then try again from the app.</p>
<p class="note">If you didn't start signing in to the Budgetrip app, close this page.</p>
</body>
</html>
`;
}

/**
 * A successful native sign-in shows who signed in and a single "Open
 * Budgetrip" link to NATIVE_CALLBACK, a verified HTTPS App Link / Universal
 * Link on the web origin (phase 7). It stays a page on the API's domain on
 * purpose: a user tap on a link to a DIFFERENT domain is what reliably makes
 * iOS and Android hand the URL to the app (a server redirect, or a same-domain
 * link, may just open the website). The link is always nativeRedirect;
 * nothing from the request is in it. If the app isn't installed the link opens
 * the web app's /auth/app-callback page instead.
 */
function nativeInterstitial(c: Context<AppEnv>, who: string, appCode: string): Response {
	const html = interstitialHtml({
		title: "Open Budgetrip",
		heading: `Signed in as ${escapeHtml(who)}`,
		body: "",
		href: escapeHtml(nativeRedirect({ code: appCode })),
		button: "Open Budgetrip",
	});
	return c.html(html, 200, INTERSTITIAL_HEADERS);
}

/** Why a native sign-in didn't finish, by error code. Fixed copy; never request text. */
const NATIVE_ERROR_REASONS: Record<string, string> = {
	bad_state: "the sign-in expired or was started elsewhere",
	cancelled: "it was cancelled",
	bad_request: "the app's request was incomplete",
	misconfigured: "this sign-in option isn't set up yet",
	rate_limited: "there were too many attempts, so wait a minute",
	account_deleted: "that account has been deleted",
	google_bad_token: "the account could not be verified",
	apple_bad_token: "the account could not be verified",
};

/**
 * A native sign-in that failed: the same interstitial as success (same
 * reason: a tap on a cross-domain link is what opens the app), with the
 * reason and a "Return to Budgetrip" link to NATIVE_CALLBACK?error=<code>.
 * The code is a fixed server-side constant (an HttpError code), never
 * request input, and is reduced to [a-z_] anyway.
 */
function nativeErrorPage(c: Context<AppEnv>, error: string): Response {
	const code = /^[a-z_]{1,40}$/.test(error) ? error : "internal";
	const reason = NATIVE_ERROR_REASONS[code] ?? "something went wrong";
	const html = interstitialHtml({
		title: "Sign-in didn't finish",
		heading: "Sign-in didn't finish",
		body: `<p>Sign-in didn't finish — ${escapeHtml(reason)}. Return to Budgetrip and try again.</p>\n`,
		href: escapeHtml(nativeRedirect({ error: code })),
		button: "Return to Budgetrip",
	});
	return c.html(html, 200, INTERSTITIAL_HEADERS);
}

/** Who a provider signed in: our user id and what to show as "Signed in as". */
interface SignedInUser {
	id: string;
	label: string;
}

/**
 * The end of every provider's callback, once its state check passed.
 * Native: resolve the user, mint a one-time app code and show the interstitial;
 * any failure shows the error interstitial, whose link goes back to the app's
 * fixed URL with a short error code (the web session cookie is never set on
 * this path). Web: start the cookie session and
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
			return nativeErrorPage(c, err instanceof HttpError ? err.code : "internal");
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
	const limited = await signInLimit(
		c,
		"google-callback",
		!!saved?.native || !!state?.startsWith(NATIVE_STATE_PREFIX),
	);
	if (limited) return limited;

	if (saved?.native && saved.codeChallenge) {
		// Native: always the interstitial, linking back to the app's fixed URL
		// with a code or a short error. The web session cookie is never set here.
		if (!state || state !== saved.state) return nativeErrorPage(c, "bad_state");
		if (!code) return nativeErrorPage(c, "cancelled");
		return completeSignIn(c, saved, () => googleUser(c, code), 302);
	}

	// A native flow whose cookie was lost: back to the app (fixed URL), not JSON.
	if (!saved?.native && state?.startsWith(NATIVE_STATE_PREFIX))
		return nativeErrorPage(c, "bad_state");
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
	const limited = await signInLimit(c, "apple-start", isNative);
	if (limited) return limited;
	const cfg = appleConfig(c.env);
	if (!cfg || !c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 32) {
		if (isNative) return nativeErrorPage(c, "misconfigured");
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
		if (!CODE_CHALLENGE_RE.test(challenge)) return nativeErrorPage(c, "bad_request");
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
	// private relay) only when email_verified says so (true or "true"); a
	// missing or false flag means the address is not stored.
	const email = claims.email && claims.email_verified === true ? claims.email : "";
	const rtEnc = tokens.refresh_token
		? await encryptRefreshToken(c.env, tokens.refresh_token)
		: null;
	// A new row inherits a suspension kept from a deleted account with the same
	// Apple ID (suspended_identities); the conflict UPDATE never touches it.
	const user = await c.env.DB.prepare(
		`INSERT INTO users (id, google_sub, apple_sub, email, display_name, apple_refresh_token_enc,
		   tagalong_suspended_at)
		 VALUES (?1, 'apple:' || ?2, ?2, ?3, ?4, ?5,
		   (SELECT suspended_at FROM suspended_identities WHERE id_hash = ?6))
		 ON CONFLICT (apple_sub) DO UPDATE SET
		   email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE users.email END,
		   apple_refresh_token_enc = COALESCE(excluded.apple_refresh_token_enc, users.apple_refresh_token_enc)
		 WHERE users.deleted_at IS NULL
		 RETURNING id, email, display_name`,
	)
		.bind(
			newId(),
			claims.sub,
			email,
			appleNameHint(userJson) ?? "Traveller",
			rtEnc,
			await identityHash(c.env, "apple", claims.sub),
		)
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
	const limited = await signInLimit(
		c,
		"apple-callback",
		!!saved?.native || !!state?.startsWith(NATIVE_STATE_PREFIX),
	);
	if (limited) return limited;

	if (saved?.native && saved.codeChallenge) {
		if (!stateOk) return nativeErrorPage(c, "bad_state");
		if (error || !code) return nativeErrorPage(c, "cancelled");
		return completeSignIn(c, saved, () => appleUser(c, code, saved.nonce, field(form.user)), 303);
	}
	if (!saved?.native && state?.startsWith(NATIVE_STATE_PREFIX))
		return nativeErrorPage(c, "bad_state");
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

/**
 * How the account signs in. google_sub holds a sentinel for Apple-only
 * ('apple:…') and deleted ('deleted:…') accounts (migration 0009), so only a
 * real Google sub counts as Google.
 */
function signInProviders(u: { google_sub: string; apple_sub: string | null }): AuthProvider[] {
	const out: AuthProvider[] = [];
	if (isRealGoogleSub(u.google_sub)) out.push("google");
	if (u.apple_sub !== null) out.push("apple");
	return out;
}

auth.get("/me", requireUser, async (c) => {
	const me = await c.env.DB.prepare(
		`SELECT id, email, display_name, home_city, home_currency, birthdate_verified_18,
		   google_sub, apple_sub, ${TAGALONG_COLUMNS}
		 FROM users WHERE id = ? AND deleted_at IS NULL`,
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
				google_sub: string;
				apple_sub: string | null;
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
		sign_in_providers: signInProviders(me),
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
	const res = await c.env.DB.prepare(
		`UPDATE users SET birthdate_verified_18 = 1, age_confirmed_at = COALESCE(age_confirmed_at, ?),
		 home_currency = ?, home_city = COALESCE(?, home_city) WHERE id = ? AND deleted_at IS NULL`,
	)
		.bind(nowIso(), body.data.home_currency, body.data.home_city ?? null, c.get("userId"))
		.run();
	if (!res.meta.changes) throw new HttpError(401, "signed_out", "Sign in first.");
	return c.json({ ok: true });
});
