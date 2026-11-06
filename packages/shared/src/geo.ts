/** Great-circle distance in km. */
export function haversineKm(
	a: { lat: number; lng: number },
	b: { lat: number; lng: number },
): number {
	const R = 6371;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Land masses you can drive across, by ISO country code. Used only to decide
 * whether a drive option is offered at all; a straight-line distance cannot
 * tell Toronto→Buffalo (drive) from Toronto→Reykjavik (no). Countries not
 * listed are drivable within their own borders only. Phase 2 replaces this with
 * a real routing answer (Google Routes).
 */
const LANDMASS: Readonly<Record<string, string>> = Object.fromEntries(
	(
		[
			["north-america", "US CA MX GT BZ SV HN NI CR PA"],
			[
				"europe",
				"GB FR DE NL BE LU CH AT IT ES PT AD MC SM VA LI DK NO SE FI PL CZ SK HU SI HR BA RS ME MK AL GR BG RO MD UA BY LT LV EE TR",
			],
			["south-america", "CO VE EC PE BO CL AR UY PY BR GY SR GF"],
			["southern-africa", "ZA NA BW ZW MZ SZ LS ZM MW"],
			["east-africa", "KE TZ UG RW BI ET"],
			["gulf", "AE SA OM QA BH KW JO"],
			["southeast-asia", "TH MY SG LA KH VN MM"],
		] as const
	).flatMap(([mass, codes]) => codes.split(" ").map((c) => [c, mass] as const)),
);

export function canDriveBetween(a: string, b: string): boolean {
	if (a === b) return true;
	const ma = LANDMASS[a];
	return ma !== undefined && ma === LANDMASS[b];
}

/** Adds n days to a YYYY-MM-DD date. */
export function addDays(isoDate: string, n: number): string {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}
