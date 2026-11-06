import { type FxRate, FxTable } from "@tagalong/shared";
import { nowIso } from "../lib/http.js";
import { FX_SOURCE, fetchRates } from "../providers/frankfurter.js";

/** Rates are pivoted on USD: the estimate tables are USD, so it is always needed. */
export const FX_PIVOT = "USD";
const MAX_AGE_MS = 12 * 3600 * 1000;

/**
 * Loads stored rates USD→each currency, refreshing any that are missing or
 * older than 12 hours. Returns a table whose every rate carries its date.
 */
export async function loadFx(db: D1Database, currencies: Iterable<string>): Promise<FxTable> {
	const quotes = [...new Set(currencies)].filter((c) => c !== FX_PIVOT).sort();
	if (quotes.length === 0) return new FxTable([]);

	const placeholders = quotes.map(() => "?").join(",");
	const { results } = await db
		.prepare(
			`SELECT base, quote, rate, as_of, fetched_at FROM fx_rates f
			 WHERE base = ? AND quote IN (${placeholders})
			   AND as_of = (SELECT MAX(as_of) FROM fx_rates g WHERE g.base = f.base AND g.quote = f.quote)`,
		)
		.bind(FX_PIVOT, ...quotes)
		.all<FxRate & { fetched_at: string }>();

	const fresh = new Map<string, FxRate>();
	for (const r of results) {
		if (Date.now() - Date.parse(r.fetched_at) < MAX_AGE_MS) fresh.set(r.quote, r);
	}
	const stale = quotes.filter((q) => !fresh.has(q));
	if (stale.length > 0) {
		const fetched = await fetchRates(FX_PIVOT, stale);
		const at = nowIso();
		if (fetched.length > 0) {
			await db.batch(
				fetched.map((r) =>
					db
						.prepare(
							`INSERT INTO fx_rates (base, quote, rate, as_of, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
							 ON CONFLICT (base, quote, as_of) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at`,
						)
						.bind(r.base, r.quote, r.rate, r.as_of, FX_SOURCE, at),
				),
			);
		}
		for (const r of fetched) fresh.set(r.quote, r);
	}
	return new FxTable([...fresh.values()]);
}
