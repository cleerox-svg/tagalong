import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanItem } from "./api.js";
import { Item } from "./PlanView.js";

const line = (over: Partial<PlanItem>): string =>
	renderToStaticMarkup(
		createElement(Item, {
			home: "CAD",
			i: {
				kind: "ticket",
				title: "A line",
				provider: "ticketmaster",
				amount_minor: 12_345,
				currency: "CAD",
				is_estimate: false,
				booking_url: null,
				fetched_at: "2026-11-10T12:00:00Z",
				method: "From the provider.",
				...over,
			},
		}),
	);

describe("live dot on plan items", () => {
	it("is absent on a Ticketmaster price, which is not labelled live", () => {
		const html = line({ provider: "ticketmaster" });
		expect(html).not.toContain("live-dot");
		expect(html).toContain("Ticketmaster");
		expect(html).not.toContain("· live");
	});

	it("is absent on Eventbrite and event-page prices", () => {
		for (const provider of ["eventbrite", "url"]) {
			expect(line({ provider })).not.toContain("live-dot");
		}
	});

	it("is present on a Duffel price, labelled live", () => {
		const html = line({ provider: "duffel", kind: "flight" });
		expect(html).toContain("live-dot");
		expect(html).toContain("Duffel · live");
	});

	it("is present on a Booking.com price, labelled live", () => {
		const html = line({ provider: "booking.com", kind: "hotel" });
		expect(html).toContain("live-dot");
		expect(html).toContain("Booking.com · live");
	});

	it("is absent on an unknown provider and on any estimate", () => {
		expect(line({ provider: "someone-else" })).not.toContain("live-dot");
		const est = line({ provider: "duffel", is_estimate: true });
		expect(est).not.toContain("live-dot");
		expect(est).toContain("estimate");
	});
});
