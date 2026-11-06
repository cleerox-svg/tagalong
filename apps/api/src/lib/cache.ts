/**
 * Provider response cache (spec §7: "prices for a short time, venue data for
 * longer"). Uses the Workers Cache API, which needs no binding; the key is an
 * internal URL that never contains an API key.
 */
export async function cachedJson<T>(
	key: string,
	ttlSeconds: number,
	load: () => Promise<T>,
	/** Skip the read (still refresh the entry): "re-check price" must not see a cached price. */
	opts: { fresh?: boolean } = {},
): Promise<T> {
	const cache =
		typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
	const req = new Request(`https://provider-cache.tagalong.internal/${key}`);
	if (cache && !opts.fresh) {
		const hit = await cache.match(req);
		if (hit) return (await hit.json()) as T;
	}
	const value = await load();
	if (cache) {
		await cache.put(
			req,
			new Response(JSON.stringify(value), {
				headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlSeconds}` },
			}),
		);
	}
	return value;
}

export class ProviderError extends Error {
	constructor(
		readonly provider: string,
		message: string,
	) {
		super(`${provider}: ${message}`);
		this.name = "ProviderError";
	}
}

/** Aborts a provider call that takes longer than `ms`; the caller falls back to an estimate. */
export const timeoutSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms);
