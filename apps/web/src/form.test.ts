import type { ParsedTripRequest } from "@tagalong/shared";
import { describe, expect, it } from "vitest";
import { applyParsed, emptyForm, toTripRequest } from "./form.js";

const toronto = { label: "Toronto, ON, Canada", lat: 43.65, lng: -79.38, country_code: "CA" };

const nothing: ParsedTripRequest = {
	origin_text: null,
	event_query: null,
	event_city: null,
	date_from: null,
	date_to: null,
	party_size: null,
	budget_amount: null,
	budget_currency: null,
	budget_scope: null,
	transport: null,
	stay: null,
	max_nights: null,
	seat_quality: null,
	vibe_tags: [],
	accessibility: null,
};

describe("confirm form", () => {
	it("turns a filled form into a valid TripRequest with minor units", () => {
		const f = {
			...emptyForm("CAD"),
			origin: toronto,
			event_query: "Knicks",
			date_from: "2027-03-01",
			date_to: "2027-03-31",
			party_size: "2",
			budget_amount: "1,200",
		};
		const r = toTripRequest(f);
		expect(r.ok && r.request.budget).toEqual({
			amount_minor: 120000,
			currency: "CAD",
			scope: "total",
		});
	});

	it("requires a confirmed origin, not just typed text", () => {
		const r = toTripRequest({
			...emptyForm("CAD"),
			origin_text: "London",
			event_query: "x",
			date_from: "2027-01-01",
			date_to: "2027-01-02",
			budget_amount: "100",
		});
		expect(r.ok).toBe(false);
		expect(!r.ok && r.errors.origin).toBeTruthy();
	});

	it("applies parsed fields but keeps the user's values where the parse found nothing", () => {
		const f = { ...emptyForm("CAD"), party_size: "3", origin: toronto, origin_text: "Toronto" };
		const next = applyParsed(
			f,
			{
				origin_text: "Toronto",
				event_query: "Knicks",
				event_city: null,
				date_from: "2027-03-01",
				date_to: null,
				party_size: null,
				budget_amount: "1200",
				budget_currency: "CAD",
				budget_scope: null,
				transport: "drive",
				stay: null,
				max_nights: null,
				seat_quality: null,
				vibe_tags: ["food"],
				accessibility: null,
			},
			"raw",
		);
		expect(next.party_size).toBe("3");
		expect(next.origin).toEqual(toronto); // same city text: confirmation kept
		expect(next.date_to).toBe("2027-03-01");
		expect(next.transport).toBe("drive");
	});

	it("clears a confirmed origin when the parse names a different city", () => {
		const f = { ...emptyForm("CAD"), origin: toronto, origin_text: "Toronto" };
		const next = applyParsed(f, { ...nothing, origin_text: "London" }, "raw");
		expect(next.origin).toBeNull();
		expect(next.origin_text).toBe("London");
	});
});
