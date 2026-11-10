/**
 * The ticket-stub month and day ("MAR", "14") for a venue-local YYYY-MM-DD.
 * Decorative: the full date is in the text beside it. Computed in UTC so the
 * viewer's own time zone can never shift the day.
 */
export function dateStub(localDate: string | null): { month: string; day: string } | null {
	const m = localDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate) : null;
	if (!m) return null;
	const month = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
		.toLocaleString(undefined, { month: "short", timeZone: "UTC" })
		.replace(".", "")
		.toUpperCase();
	return { month, day: String(Number(m[3])) };
}
