import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HttpError, type AppEnv } from "./http.js";

/**
 * Spec §8: explicit allowlists, no wildcards.
 *
 * WEB_ORIGINS: the web app. The only origins that may use the session cookie
 * (credentialed CORS, cookie-authenticated writes, the cookie chat socket) or
 * be a sign-in return target. WEB_ORIGINS[0] is the production web origin.
 */
export const WEB_ORIGINS: readonly string[] = [
	"https://tagalong.averrow.com",
	"http://localhost:5173",
];

/**
 * NATIVE_ORIGINS: the Capacitor webview (iOS, Android). Cross-site to the API,
 * so it never has the cookie; it authenticates with a bearer token instead.
 * CORS without credentials; never a return target or a cookie-write origin.
 */
export const NATIVE_ORIGINS: readonly string[] = ["capacitor://localhost", "https://localhost"];

/** @deprecated Web origins only; kept for existing imports. Use WEB_ORIGINS. */
export const ALLOWED_ORIGINS = WEB_ORIGINS;

const corsBase = {
	allowMethods: ["GET", "POST", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization"],
	maxAge: 600,
};
const webCors = cors({
	...corsBase,
	origin: (origin) => (WEB_ORIGINS.includes(origin) ? origin : null),
	credentials: true,
});
const nativeCors = cors({
	...corsBase,
	origin: (origin) => (NATIVE_ORIGINS.includes(origin) ? origin : null),
});

export const corsMiddleware = createMiddleware(async (c, next) =>
	NATIVE_ORIGINS.includes(c.req.header("Origin") ?? "") ? nativeCors(c, next) : webCors(c, next),
);

/** A bearer-authenticated request (the native app). Browsers never add one on their own. */
export const hasBearer = (authorization: string | undefined) =>
	/^Bearer /i.test(authorization ?? "");

/** Refuses anything but a JSON body, so a plain HTML form cannot post here. */
export function assertJsonBody(contentType: string | undefined): void {
	if (!(contentType ?? "").toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "json_only", "Send JSON.");
	}
}

/**
 * CSRF guard for writes. The session cookie is SameSite=Lax, which already
 * stops cross-site POSTs; this also stops any other origin on the same site,
 * and requires a JSON body so a plain HTML form cannot post here at all.
 *
 * A bearer request (Authorization: Bearer ...) carries no ambient credential,
 * so it skips the Origin check; session lookup then uses ONLY the bearer token,
 * never the cookie (auth/session.ts). It still must be JSON.
 */
export const requireTrustedWrite = createMiddleware<AppEnv>(async (c, next) => {
	if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS")
		return next();
	if (!hasBearer(c.req.header("Authorization"))) {
		const origin = c.req.header("Origin");
		if (!origin || !WEB_ORIGINS.includes(origin)) {
			throw new HttpError(403, "bad_origin", "Writes are only accepted from the Tagalong web app.");
		}
	}
	assertJsonBody(c.req.header("Content-Type"));
	return next();
});
