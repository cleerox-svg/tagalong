import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HttpError, type AppEnv } from "./http.js";

/** Spec §8: an explicit allowlist, no wildcards. */
export const ALLOWED_ORIGINS: readonly string[] = [
	"https://tagalong.averrow.com",
	"http://localhost:5173",
];

export const corsMiddleware = cors({
	origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
	credentials: true,
	allowMethods: ["GET", "POST", "OPTIONS"],
	allowHeaders: ["Content-Type"],
	maxAge: 600,
});

/**
 * CSRF guard for cookie-authenticated writes. The session cookie is
 * SameSite=Lax, which already stops cross-site POSTs; this also stops any
 * other origin on the same site, and requires a JSON body so a plain HTML form
 * cannot post here at all.
 */
export const requireTrustedWrite = createMiddleware<AppEnv>(async (c, next) => {
	if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS")
		return next();
	const origin = c.req.header("Origin");
	if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
		throw new HttpError(403, "bad_origin", "Writes are only accepted from the Tagalong web app.");
	}
	const type = c.req.header("Content-Type") ?? "";
	if (!type.toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "json_only", "Send JSON.");
	}
	return next();
});
