import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dateStub } from "./date.js";

// The stub is computed in UTC, so the viewer's zone must never move the day.
// Each case runs under a zone behind UTC and one ahead of it.
const ZONES = ["America/Los_Angeles", "Pacific/Auckland"];

describe.each(ZONES)("dateStub in %s", (zone) => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.TZ;
		process.env.TZ = zone;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.TZ;
		else process.env.TZ = saved;
	});

	it("runs in the requested zone", () => {
		const offset = new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset();
		expect(zone === "America/Los_Angeles" ? offset > 0 : offset < 0).toBe(true);
	});

	it("returns null for no date", () => {
		expect(dateStub(null)).toBeNull();
	});

	it.each(["", "2026-3-1", "2026/03/01", "01-03-2026", "2026-03-01T00:00:00Z", "soon"])(
		"returns null for malformed %j",
		(s) => {
			expect(dateStub(s)).toBeNull();
		},
	);

	it("gives MAR / 1 for the first of the month, without a leading zero", () => {
		expect(dateStub("2026-03-01")).toEqual({ month: "MAR", day: "1" });
	});

	it("gives DEC / 31 for the last day of the year", () => {
		expect(dateStub("2026-12-31")).toEqual({ month: "DEC", day: "31" });
	});

	it("drops the leading zero on a single-digit day", () => {
		expect(dateStub("2026-07-09")).toEqual({ month: "JUL", day: "9" });
	});
});
