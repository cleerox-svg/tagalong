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
 * Bounds on one prune. Exported so tests can lower them instead of seeding
 * hundreds of thousands of rows; production always uses PRUNE_LIMITS.
 */
export interface PruneLimits {
	/** Rows deleted per statement, so no single DELETE is huge. */
	batchSize: number;
	/** Max IP-keyed batches per prune, across all IP prefixes. */
	ipMaxBatches: number;
	/** Max batches for the general >24 h sweep, after the IP rows are done. */
	generalMaxBatches: number;
	/** Wall-clock budget for the whole prune, in ms (checked between batches). */
	timeBudgetMs: number;
}

/**
 * IP rows: up to 1,000 x 5,000 = 5M rows per run, far beyond any real load,
 * so in practice every expired IP row goes on each run. General rows keep the
 * old 100k cap (each of those batches is a full scan). 60 s fits easily inside
 * a scheduled handler (15 min wall clock for a cron interval of an hour or more).
 */
export const PRUNE_LIMITS: PruneLimits = {
	batchSize: 5_000,
	ipMaxBatches: 1_000,
	generalMaxBatches: 20,
	timeBudgetMs: 60_000,
};

/**
 * The smallest string greater than every string starting with `prefix`
 * (last character + 1, e.g. "ip:" -> "ip;"), so `key >= prefix AND key < end`
 * is a range on the (key, window_start) primary-key index instead of a scan.
 */
function prefixUpperBound(prefix: string): string {
	const last = prefix.charCodeAt(prefix.length - 1);
	return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/**
 * Deletes rate-limit rows whose window has ended, in two phases:
 *  1. IP-keyed rows (`ip:` and each legacy IP prefix) with window_start more
 *     than 1 h ago (no IP window is longer). One statement per prefix, using a
 *     primary-key range so the index is used, drained until a batch comes back
 *     short. These go first so a backlog of other rows can never delay them.
 *  2. Any row with window_start more than 24 h ago (no window is longer),
 *     within the general cap.
 * A live window is never deleted. `window_start` is in Unix seconds. If a cap
 * or the time budget stops a phase early, the rest goes on the next cron run
 * and "rate-limit prune capped" is logged with counts only (never a key, as
 * keys hold IPs). Returns rows deleted.
 */
export async function pruneRateLimits(
	db: D1Database,
	nowMs: number,
	limits: PruneLimits = PRUNE_LIMITS,
): Promise<number> {
	const { batchSize, ipMaxBatches, generalMaxBatches, timeBudgetMs } = limits;
	const nowSec = Math.floor(nowMs / 1000);
	const deadline = Date.now() + timeBudgetMs;
	let capped = false;

	// Phase 1: IP rows. Fixed SQL text; every value is bound.
	const ipStmt = db.prepare(
		`DELETE FROM rate_limits WHERE rowid IN (
		   SELECT rowid FROM rate_limits
		   WHERE key >= ? AND key < ? AND window_start < ?
		   LIMIT ?
		 )`,
	);
	let ipDeleted = 0;
	let ipBatches = 0;
	for (const prefix of IP_KEY_PREFIXES) {
		const stmt = ipStmt.bind(
			prefix,
			prefixUpperBound(prefix),
			nowSec - IP_MAX_WINDOW_SECONDS,
			batchSize,
		);
		for (;;) {
			if (ipBatches >= ipMaxBatches || Date.now() >= deadline) {
				capped = true;
				break;
			}
			ipBatches++;
			const changes = (await stmt.run()).meta.changes ?? 0;
			ipDeleted += changes;
			if (changes < batchSize) break;
		}
		if (capped) break;
	}

	// Phase 2: everything past the 24-hour cutoff (no index on window_start,
	// so each batch scans; hence the lower cap).
	const generalStmt = db
		.prepare(
			`DELETE FROM rate_limits WHERE rowid IN (
			   SELECT rowid FROM rate_limits WHERE window_start < ? LIMIT ?
			 )`,
		)
		.bind(nowSec - MAX_WINDOW_SECONDS, batchSize);
	let otherDeleted = 0;
	for (let i = 0; ; i++) {
		if (i >= generalMaxBatches || Date.now() >= deadline) {
			capped = true;
			break;
		}
		const changes = (await generalStmt.run()).meta.changes ?? 0;
		otherDeleted += changes;
		if (changes < batchSize) break;
	}

	if (capped) console.warn("rate-limit prune capped", { ipDeleted, otherDeleted });
	return ipDeleted + otherDeleted;
}
