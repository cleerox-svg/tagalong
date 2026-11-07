import { describe, expect, it } from "vitest";
import { pinnedEvent, TripRequestSchema } from "./types.js";

const base = {
	origin: { label: "Toronto, ON, Canada", lat: 43.65, lng: -79.38, country_code: "CA" },
	event: { query: "Tuner Evolution" },
	date_from: "2027-05-08",
	date_to: "2027-05-08",
	party_size: 2,
	budget: { amount_minor: 80000, currency: "CAD", scope: "total" },
	prefs: { transport: "any", stay: "any", max_nights: 2, seat_quality: "any", vibe_tags: [] },
};

describe("TripRequestSchema: picked and described events", () => {
	it("accepts each kind of pinned event", () => {
		for (const pinned of [
			{ provider: "ticketmaster", id: "vvG1zZ9abc" },
			{ provider: "eventbrite", id: "123456789012" },
			{ provider: "url", url: "https://example.com/events/show" },
		]) {
			expect(TripRequestSchema.safeParse({ ...base, event: { query: "x", pinned } }).success).toBe(
				true,
			);
		}
	});

	it("rejects a non-http link and a malformed Eventbrite id", () => {
		for (const pinned of [
			{ provider: "url", url: "javascript:alert(1)" },
			{ provider: "url", url: "file:///etc/passwd" },
			{ provider: "eventbrite", id: "abc" },
		]) {
			expect(TripRequestSchema.safeParse({ ...base, event: { query: "x", pinned } }).success).toBe(
				false,
			);
		}
	});

	it("needs a city and one date for a described event, and never both kinds at once", () => {
		const manual = (event: object, over: object = {}) =>
			TripRequestSchema.safeParse({ ...base, ...over, event: { query: "Meet", ...event } }).success;
		expect(manual({ manual: true, city: "Ottawa" })).toBe(true);
		expect(manual({ manual: true })).toBe(false);
		expect(manual({ manual: true, city: "Ottawa" }, { date_to: "2027-05-09" })).toBe(false);
		expect(
			manual({ manual: true, city: "Ottawa", pinned: { provider: "eventbrite", id: "1234567" } }),
		).toBe(false);
	});

	it("reads the older ticketmaster_event_id as a pinned Ticketmaster event", () => {
		expect(pinnedEvent({ event: { query: "x", ticketmaster_event_id: "TM-1" } })).toEqual({
			provider: "ticketmaster",
			id: "TM-1",
		});
		expect(
			pinnedEvent({
				event: { query: "x", pinned: { provider: "eventbrite", id: "1234567" } },
			}),
		).toEqual({ provider: "eventbrite", id: "1234567" });
		expect(pinnedEvent({ event: { query: "x" } })).toBeNull();
	});
});
