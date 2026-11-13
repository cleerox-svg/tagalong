/**
 * What Tagalong tells Jarvis (contract v1, agreed with Jarvis; see
 * docs/SETUP.md "Jarvis read API").
 *
 * READ-ONLY. Nothing reachable from this module writes: every statement is a
 * SELECT. Any change to the shape below is a contract v2, agreed with Jarvis
 * first.
 *
 * Any Worker on the same Cloudflare account could bind to this, so it exposes
 * only a saved trip's title, date, city and its cheapest stored package total:
 * never the raw request, budget, party, preferences, origin or home location,
 * groups, chat, share links, alerts, display names or booking links.
 *
 * Prices come only from stored package / package_item rows (provider figures
 * or labelled estimates). No AI is involved and no currency is converted.
 */
import { isRealGoogleSub } from "../auth/suspended-identity.js";

export const JARVIS_CONTRACT_VERSION = 1;

/** Jarvis rejects the whole answer past these, so they are enforced here. */
const MAX_TRIPS = 20;
const MAX_TITLE = 120;
const MAX_CITY = 80;
const MAX_AMOUNT_MINOR = 10_000_000_000;
/** RFC 5321's practical ceiling for an address. */
const MAX_EMAIL = 320;
/** Rows read before the per-row checks, so a few unusable rows don't shorten the list. */
const SCAN_LIMIT = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export interface JarvisCheapest {
	amountMinor: number;
	currency: string;
	isEstimate: boolean;
	asOf: string;
}

export interface JarvisTrip {
	title: string;
	date: string;
	city: string | null;
	cheapest: JarvisCheapest | null;
}

export interface JarvisUpcomingTrips {
	trips: JarvisTrip[];
}

const empty = (): JarvisUpcomingTrips => ({ trips: [] });

/** JARVIS_READ_EMAILS: comma/space/semicolon-separated, case-insensitive. */
export function parseAllowlist(raw: unknown): Set<string> {
	if (typeof raw !== "string") return new Set();
	return new Set(
		raw
			.split(/[\s,;]+/)
			.map((e) => e.trim().toLowerCase())
			.filter((e) => e !== ""),
	);
}

/**
 * Trimmed, then cut on a code-point boundary so a surrogate pair is never
 * split. The budget is counted in UTF-16 units, which is what Jarvis's length
 * check counts.
 */
export function clipText(text: string, max: number): string {
	let out = "";
	for (const ch of text.trim()) {
		if (out.length + ch.length > max) break;
		out += ch;
	}
	return out.trimEnd();
}

/** UTC today minus one day, YYYY-MM-DD: yesterday's trips still count as upcoming. */
export function upcomingCutoff(now: number = Date.now()): string {
	return new Date(now - 86_400_000).toISOString().slice(0, 10);
}

function isRealDate(s: string): boolean {
	if (!DATE_RE.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * The one live, Google-signed-in account with this address, or null. The
 * users.email column is neither unique nor lowercased, so zero or several
 * matches both answer null. Apple-only and deleted accounts carry a sentinel
 * google_sub (migration 0009) and never match.
 */
async function userIdForEmail(db: D1Database, email: string): Promise<string | null> {
	const { results } = await db
		.prepare("SELECT id, google_sub FROM users WHERE lower(trim(email)) = ? AND deleted_at IS NULL")
		.bind(email)
		.all<{ id: string; google_sub: string }>();
	const matches = results.filter((u) => isRealGoogleSub(u.google_sub));
	return matches.length === 1 ? matches[0]!.id : null;
}

interface TripRow {
	plan_id: string;
	status: string;
	event_name: string | null;
	event_query: string | null;
	trip_date: string | null;
	city: string | null;
}

interface CheapestRow {
	total_minor: number | null;
	currency: string | null;
	is_estimate: number | null;
	fetched_at: string | null;
}

/**
 * The cheapest package of a finished plan, from its stored rows only. Null
 * when the package has no items, or any stored value is outside the contract
 * (better to show no price than a wrong one).
 */
function toCheapest(rows: CheapestRow[]): JarvisCheapest | null {
	const first = rows[0];
	if (!first) return null;
	const { total_minor: amount, currency } = first;
	if (
		typeof amount !== "number" ||
		!Number.isInteger(amount) ||
		amount < 0 ||
		amount > MAX_AMOUNT_MINOR
	)
		return null;
	if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) return null;

	let isEstimate = false;
	let oldest: number | null = null;
	for (const r of rows) {
		// A LEFT JOIN row with no item: the package has no items.
		if (r.fetched_at === null) return null;
		const t = Date.parse(r.fetched_at);
		if (Number.isNaN(t)) return null;
		if (oldest === null || t < oldest) oldest = t;
		if (r.is_estimate === 1) isEstimate = true;
	}
	if (oldest === null) return null;
	return { amountMinor: amount, currency, isEstimate, asOf: new Date(oldest).toISOString() };
}

/**
 * The user's upcoming saved trips (their "My trips"), soonest first, as
 * Jarvis sees them.
 *
 * Bad input, an address not on JARVIS_READ_EMAILS (empty or unset: nobody),
 * or no single matching account all answer `{ trips: [] }`. An internal
 * failure (D1) is not hidden behind an empty list: it rejects, and
 * JarvisReadApi.getUpcomingTrips turns it into a fixed `tagalong_unavailable`.
 */
export async function readUpcomingTripsForJarvis(
	env: Env,
	email: unknown,
	now: number = Date.now(),
): Promise<JarvisUpcomingTrips> {
	if (typeof email !== "string" || email.length > MAX_EMAIL) return empty();
	const normalised = email.trim().toLowerCase();
	if (normalised === "") return empty();
	if (!parseAllowlist(env.JARVIS_READ_EMAILS).has(normalised)) return empty();

	const userId = await userIdForEmail(env.DB, normalised);
	if (!userId) return empty();

	// Same joins and ordering as GET /trips, plus a stable tie-break.
	const { results } = await env.DB.prepare(
		`SELECT s.latest_plan_id AS plan_id, p.status, e.name AS event_name, t.event_query,
		   COALESCE(e.local_date, t.date_from) AS trip_date,
		   COALESCE(e.city, t.event_city) AS city
		 FROM saved_trips s
		 JOIN trip_requests t ON t.id = s.trip_request_id
		 JOIN plans p ON p.id = s.latest_plan_id AND p.user_id = s.user_id
		 LEFT JOIN events e ON e.id = p.event_id
		 WHERE s.user_id = ? AND COALESCE(e.local_date, t.date_from) >= ?
		 ORDER BY COALESCE(e.local_date, t.date_from), s.created_at, s.trip_request_id
		 LIMIT ?`,
	)
		.bind(userId, upcomingCutoff(now), SCAN_LIMIT)
		.all<TripRow>();

	const picked: { row: TripRow; title: string; date: string; city: string | null }[] = [];
	for (const row of results) {
		if (picked.length >= MAX_TRIPS) break;
		if (typeof row.trip_date !== "string" || !isRealDate(row.trip_date)) continue;
		const name = typeof row.event_name === "string" ? clipText(row.event_name, MAX_TITLE) : "";
		const title =
			name !== ""
				? name
				: typeof row.event_query === "string"
					? clipText(row.event_query, MAX_TITLE)
					: "";
		if (title === "") continue;
		const city = typeof row.city === "string" ? clipText(row.city, MAX_CITY) : "";
		picked.push({ row, title, date: row.trip_date, city: city === "" ? null : city });
	}

	// One batch for every finished plan's cheapest package and its items.
	const done = picked.filter((p) => p.row.status === "done");
	const cheapestByPlan = new Map<string, JarvisCheapest | null>();
	if (done.length > 0) {
		const stmt = env.DB.prepare(
			`SELECT pk.total_minor, pk.currency, pi.is_estimate, pi.fetched_at
			 FROM packages pk
			 LEFT JOIN package_items pi ON pi.package_id = pk.id
			 WHERE pk.id = (SELECT id FROM packages WHERE plan_id = ? ORDER BY total_minor, rank LIMIT 1)`,
		);
		const answers = await env.DB.batch<CheapestRow>(done.map((p) => stmt.bind(p.row.plan_id)));
		done.forEach((p, i) => cheapestByPlan.set(p.row.plan_id, toCheapest(answers[i]!.results)));
	}

	return {
		trips: picked.map(({ row, title, date, city }) => ({
			title,
			date,
			city,
			cheapest: cheapestByPlan.get(row.plan_id) ?? null,
		})),
	};
}
