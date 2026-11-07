import type { ParsedTripRequest } from "@tagalong/shared";
import { describe, expect, it } from "vitest";
import {
	applyParsed,
	describeEvent,
	emptyForm,
	pinEvent,
	toTripRequest,
	unpinEvent,
} from "./form.js";

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
	event_url: null,
	event_category: null,
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
				...nothing,
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

describe("picked and described events", () => {
	const ready = {
		...emptyForm("CAD"),
		origin: toronto,
		party_size: "2",
		budget_amount: "900",
		date_from: "2027-05-01",
		date_to: "2027-05-31",
	};
	const show = {
		pinned: { provider: "eventbrite" as const, id: "812345678901" },
		name: "Ottawa Gaming Expo",
		city: "Ottawa",
		local_date: "2027-05-15",
	};

	it("pins a picked event and plans exactly its date", () => {
		const r = toTripRequest(pinEvent(ready, show));
		expect(r.ok && r.request.event).toEqual({
			query: "Ottawa Gaming Expo",
			city: "Ottawa",
			pinned: { provider: "eventbrite", id: "812345678901" },
		});
		expect(r.ok && [r.request.date_from, r.request.date_to]).toEqual(["2027-05-15", "2027-05-15"]);
	});

	it("unpinning keeps the fields but searches again", () => {
		const r = toTripRequest(unpinEvent(pinEvent(ready, show)));
		expect(r.ok && r.request.event.pinned).toBeUndefined();
	});

	it("a described event needs a city and plans one date", () => {
		const f = describeEvent({ ...ready, event_city: "" }, "Fall Car Meet");
		const missing = toTripRequest(f);
		expect(!missing.ok && missing.errors.event_city).toBeTruthy();
		const r = toTripRequest({ ...f, event_city: "Ottawa", date_from: "2027-05-08" });
		expect(r.ok && r.request.event).toEqual({
			query: "Fall Car Meet",
			city: "Ottawa",
			manual: true,
		});
		expect(r.ok && [r.request.date_from, r.request.date_to]).toEqual(["2027-05-08", "2027-05-08"]);
	});

	it("a new event from the parse step drops the old pin", () => {
		const next = applyParsed(pinEvent(ready, show), { ...nothing, event_query: "Raptors" }, "x");
		expect(next.pinned).toBeUndefined();
		expect(next.event_query).toBe("Raptors");
	});
});
