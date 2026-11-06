/**
 * City search for origins (spec §5: "a free-text city, geocoded. If it's
 * ambiguous, ask"). Places API (New) Text Search returns several matches for
 * "London" — London UK, London ON — so the user can pick one. City level only:
 * we keep the city's centre point, never an address.
 */
import type { Place } from "@tagalong/shared";
import { cachedJson, ProviderError } from "../lib/cache.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELDS = "places.formattedAddress,places.location,places.addressComponents";

interface PlacesResponse {
	places?: Array<{
		formattedAddress?: string;
		location?: { latitude: number; longitude: number };
		addressComponents?: Array<{ shortText?: string; types?: string[] }>;
	}>;
}

export async function searchCities(apiKey: string, query: string): Promise<Place[]> {
	const q = query.trim().slice(0, 120);
	if (!q) return [];
	return cachedJson(`places/city?q=${encodeURIComponent(q.toLowerCase())}`, 7 * 86400, async () => {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Goog-Api-Key": apiKey,
				"X-Goog-FieldMask": FIELDS,
			},
			body: JSON.stringify({ textQuery: q, includedType: "locality", pageSize: 5 }),
		});
		if (!res.ok) throw new ProviderError("google-places", `HTTP ${res.status}`);
		const body = (await res.json()) as PlacesResponse;
		const out: Place[] = [];
		for (const p of body.places ?? []) {
			const country = p.addressComponents?.find((a) => a.types?.includes("country"))?.shortText;
			if (!p.location || !p.formattedAddress || !country || !/^[A-Z]{2}$/.test(country)) continue;
			out.push({
				label: p.formattedAddress,
				lat: Math.round(p.location.latitude * 1e4) / 1e4,
				lng: Math.round(p.location.longitude * 1e4) / 1e4,
				country_code: country,
			});
		}
		return out;
	});
}
