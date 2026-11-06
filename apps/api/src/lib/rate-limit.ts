import { HttpError } from "./http.js";

/**
 * Fixed-window counter in D1. One upsert per call, no SELECT-then-INSERT.
 * Throws 429 when the caller is over `limit` in the current window.
 */
export async function rateLimit(
	db: D1Database,
	key: string,
	limit: number,
	windowSeconds: number,
): Promise<void> {
	const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
	const row = await db
		.prepare(
			`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
			 ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
			 RETURNING count`,
		)
		.bind(key, windowStart)
		.first<{ count: number }>();
	if ((row?.count ?? 0) > limit) {
		throw new HttpError(429, "rate_limited", "Too many requests. Try again shortly.");
	}
}
