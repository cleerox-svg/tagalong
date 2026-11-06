/**
 * Daily FX reference rates (European Central Bank, via Frankfurter; no key).
 * Spec §2.3: convert with a stored rate and its date.
 */
import type { FxRate } from "@tagalong/shared";
import { ProviderError } from "../lib/cache.js";

export const FX_SOURCE = "frankfurter/ecb";

export async function fetchRates(base: string, quotes: readonly string[]): Promise<FxRate[]> {
	if (quotes.length === 0) return [];
	const q = new URLSearchParams({ base, symbols: quotes.join(",") });
	const res = await fetch(`https://api.frankfurter.dev/v1/latest?${q}`, {
		headers: { Accept: "application/json" },
	});
	if (!res.ok) throw new ProviderError("fx", `HTTP ${res.status} for ${base}->${quotes.join(",")}`);
	const body = (await res.json()) as {
		base?: string;
		date?: string;
		rates?: Record<string, number>;
	};
	if (body.base !== base || !body.date || !body.rates)
		throw new ProviderError("fx", "unexpected response");
	return Object.entries(body.rates)
		.filter(([, rate]) => typeof rate === "number" && rate > 0)
		.map(([quote, rate]) => ({ base, quote, rate, as_of: body.date as string }));
}
