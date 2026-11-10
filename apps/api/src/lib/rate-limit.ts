import { HttpError } from "./http.js";

/**
 * The longest window any caller may use (the per-day Tagalong limits). Every
 * row's window has ended once its `window_start` is this far in the past.
 */
export const MAX_WINDOW_SECONDS = 86_400;

/**
 * Rows keyed by a client IP use short windows only, so they can be pruned
 * long before the general 24-hour cutoff. The privacy policy promises IP
 * addresses are kept at most 24 hours; with the cron every 6 hours
 * (wrangler.jsonc) an IP row lives at most IP_MAX_WINDOW_SECONDS + 6 h = 7 h.
 */
export const IP_MAX_WINDOW_SECONDS = 3_600;

/** Every IP-keyed row starts with this, so pruning can find it. */
const IP_KEY_PREFIX = "ip:";

/**
 * Key prefixes IP-keyed rows used before the `ip:` prefix existed (all 60 s
 * windows). Pruned on the same 1-hour cutoff so rows written before the
 * deploy are covered too. No user-keyed row starts with any of these
 * (`share:` for share-link creation is a different prefix from `shared:`).
 * Safe to remove once no such rows remain.
 */
const LEGACY_IP_KEY_PREFIXES = ["shared:", "native-exchange:", "signin:"] as const;

const IP_KEY_PREFIXES = [IP_KEY_PREFIX, ...LEGACY_IP_KEY_PREFIXES];

/** Rows deleted per statement, so one prune never runs one huge DELETE. */
const PRUNE_BATCH = 5_000;
/** Upper bound on batches per prune; whatever is left goes on the next cron run. */
const PRUNE_MAX_BATCHES = 20;

/**
 * Fixed-window counter in D1. One upsert per call, no SELECT-then-INSERT.
 * Throws 429 when the caller is over `limit` in the current window.
 * `windowSeconds` must not exceed MAX_WINDOW_SECONDS (pruning relies on it).
 */
export async function rateLimit(
	db: D1Database,
	key: string,
	limit: number,
	windowSeconds: number,
): Promise<void> {
	if (windowSeconds > MAX_WINDOW_SECONDS) throw new Error("rate-limit window too long");
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

/**
 * Rate limit keyed by client IP. Always use this, never `rateLimit` with an
 * IP in the key: the `ip:` prefix is what lets `pruneRateLimits` delete IP
 * rows on the short schedule the privacy policy promises.
 */
export async function rateLimitByIp(
	db: D1Database,
	scope: string,
	ip: string,
	limit: number,
	windowSeconds: number,
): Promise<void> {
	if (windowSeconds > IP_MAX_WINDOW_SECONDS) throw new Error("IP rate-limit window too long");
	await rateLimit(db, `${IP_KEY_PREFIX}${scope}:${ip}`, limit, windowSeconds);
}

/**
 * Deletes rate-limit rows whose window has ended:
 *  - any row with window_start more than 24 h ago (no window is longer), and
 *  - any IP-keyed row (`ip:` or a legacy IP prefix) with window_start more
 *    than 1 h ago (no IP window is longer).
 * A live window is never deleted. `window_start` is in Unix seconds.
 * Batched by rowid so each statement is bounded. Returns rows deleted.
 */
export async function pruneRateLimits(db: D1Database, nowMs: number): Promise<number> {
	const nowSec = Math.floor(nowMs / 1000);
	// One "substr(key, 1, ?) = ?" per prefix; the SQL text is fixed, values are bound.
	const prefixMatch = IP_KEY_PREFIXES.map(() => "substr(key, 1, ?) = ?").join(" OR ");
	const stmt = db
		.prepare(
			`DELETE FROM rate_limits WHERE rowid IN (
			   SELECT rowid FROM rate_limits
			   WHERE window_start < ?
			      OR (window_start < ? AND (${prefixMatch}))
			   LIMIT ?
			 )`,
		)
		.bind(
			nowSec - MAX_WINDOW_SECONDS,
			nowSec - IP_MAX_WINDOW_SECONDS,
			...IP_KEY_PREFIXES.flatMap((p) => [p.length, p]),
			PRUNE_BATCH,
		);
	let deleted = 0;
	for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
		const changes = (await stmt.run()).meta.changes ?? 0;
		deleted += changes;
		if (changes < PRUNE_BATCH) break;
	}
	return deleted;
}
