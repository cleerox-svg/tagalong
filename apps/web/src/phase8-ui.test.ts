import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "./api.js";
import { Planner } from "./Planner.js";
import { boxesMessage, MeContext, TagalongGate } from "./TagalongGate.js";

// Phase 8 review fixes: the Tagalong join form's messages and Terms link, and
// the Planner's AI note. Rendered to static markup: web tests run in node.

const ME: Me = {
	id: "u1",
	email: "a@example.com",
	display_name: "Ana",
	home_city: "Toronto",
	home_currency: "CAD",
	birthdate_verified_18: true,
	tagalong: {
		opted_in: false,
		name: null,
		city: null,
		safety_acked: false,
		trusted: false,
		suspended: false,
	},
	is_moderator: false,
};

/** Visible text: tags dropped, entities decoded, whitespace collapsed. */
const text = (html: string): string =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");

const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in UI render tests")));
beforeEach(() => {
	fetchSpy.mockClear();
	vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("boxesMessage", () => {
	it("asks for both boxes when both are unticked", () => {
		expect(boxesMessage({ confirm: true, agree: true })).toBe("Tick both boxes to join.");
	});

	it("names the Terms box when only it is unticked", () => {
		expect(boxesMessage({ confirm: false, agree: true })).toBe(
			"Tick the box to agree to the Terms of Use.",
		);
	});

	it("names the name-and-city box when only it is unticked", () => {
		const msg = boxesMessage({ confirm: true, agree: false });
		expect(msg).toBe(
			"Tick the box to confirm you understand your name and city will be shown to other Tagalong members.",
		);
		expect(msg).not.toContain("Terms");
	});

	it("says nothing when both are ticked", () => {
		expect(boxesMessage({ confirm: false, agree: false })).toBeUndefined();
	});
});

describe("TagalongGate", () => {
	const html = renderToStaticMarkup(
		createElement(
			MeContext.Provider,
			{ value: { me: ME, reload: async () => {} } },
			createElement(TagalongGate),
		),
	);

	it("renders the join form", () => {
		expect(html).toContain("Join Tagalong");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("follows the Terms checkbox with a /terms link outside the <label>", () => {
		const labels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)];
		const agree = labels.find((m) => (m[1] ?? "").includes("I agree to the Terms of Use"));
		expect(agree).toBeDefined();
		// The label holds only the checkbox and its text: no link inside it.
		expect(agree?.[1]).toContain('type="checkbox"');
		expect(agree?.[1]).not.toContain("<a");
		// The very next element is the Terms link.
		const after = html.slice((agree?.index ?? 0) + (agree?.[0].length ?? 0));
		expect(after).toMatch(
			/^<p class="note check-link"><a href="\/terms"[^>]*>Read the Terms of Use<\/a><\/p>/,
		);
	});

	it("puts no link inside any checkbox label", () => {
		for (const m of html.matchAll(/<label class="check">([\s\S]*?)<\/label>/g))
			expect(m[1]).not.toContain("<a");
	});
});

describe("Planner AI note", () => {
	const html = renderToStaticMarkup(createElement(Planner, { me: ME }));

	it("says the AI neither estimates prices nor ranks packages", () => {
		const note = /<p class="note ai-note" id="ai-note">([\s\S]*?)<\/p>/.exec(html)?.[1];
		expect(note).toBeDefined();
		const t = text(note ?? "");
		expect(t).toContain("estimates prices");
		expect(t).toContain("rank packages");
		expect(t).toContain("It never finds, sets or estimates prices");
		expect(t).toContain("it doesn't choose or rank packages");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("is described-by only on the textarea", () => {
		const users = [...html.matchAll(/<(\w+)\b[^>]*\baria-describedby="([^"]*)"/g)].filter((m) =>
			(m[2] ?? "").split(/\s+/).includes("ai-note"),
		);
		expect(users.map((m) => m[1])).toEqual(["textarea"]);
		expect(html.match(/id="ai-note"/g)).toHaveLength(1);
	});
});
