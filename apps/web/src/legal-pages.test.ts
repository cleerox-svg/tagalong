import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import storeListingRaw from "../../../docs/STORE_LISTING.md?raw";
import { DELETE_CONFIRM_WORD } from "./account.js";
import { isLegalPath, LEGAL_PAGES, legalPage, SUPPORT_EMAIL } from "./Legal.js";

// The public pages both stores require (spec §9 phase 8). Rendered to static
// markup: the web tests run in node, without a DOM.

const PATHS = ["/privacy", "/terms", "/support", "/delete-account"] as const;

const render = (path: string): string =>
	renderToStaticMarkup(createElement(Fragment, null, legalPage(path)));

/** Visible text: tags dropped, entities decoded, whitespace collapsed. */
const text = (html: string): string =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");

const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in legal pages")));
beforeEach(() => {
	fetchSpy.mockClear();
	vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("isLegalPath", () => {
	it("accepts the four store pages", () => {
		for (const p of PATHS) expect(isLegalPath(p), p).toBe(true);
		expect(Object.keys(LEGAL_PAGES).sort()).toEqual([...PATHS].sort());
	});

	it("rejects every other path", () => {
		for (const p of [
			"/",
			"",
			"/account",
			"/trips",
			"/privacy-policy",
			"/Privacy",
			"privacy",
			"/privacy?x=1",
			"/support/more",
			"/s/privacy",
			"/delete",
			"/toString",
			"/__proto__",
			"constructor",
			"hasOwnProperty",
		])
			expect(isLegalPath(p), p).toBe(false);
	});

	it("legalPage returns null for a non-legal path", () => {
		expect(legalPage("/")).toBeNull();
		expect(legalPage("/toString")).toBeNull();
	});
});

describe("legal pages render", () => {
	it("each page renders its title and contact, with no network request", () => {
		for (const p of PATHS) {
			const html = render(p);
			expect(html, p).toContain(`<h1 id="legal-h">${LEGAL_PAGES[p]}</h1>`);
			expect(html, p).toContain(`mailto:${SUPPORT_EMAIL}`);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("delete-account names the confirm word and the support email", () => {
		const t = text(render("/delete-account"));
		expect(DELETE_CONFIRM_WORD).toBe("DELETE");
		expect(t).toContain(`type ${DELETE_CONFIRM_WORD} in capital letters`);
		expect(t).toContain("support@averrow.com");
	});

	it("privacy states the 24-hour IP limit", () => {
		const t = text(render("/privacy"));
		expect(t).toContain("These IP records are kept for at most 24 hours");
		expect(t).toContain("IP records for abuse prevention: at most 24 hours.");
	});

	it("privacy names every processor docs/STORE_LISTING.md lists", () => {
		// The doc's "Processors" paragraph (§1), plus Frankfurter from the same paragraph.
		const para = /\*\*Processors\*\*([\s\S]*?)\n\n/.exec(storeListingRaw)?.[1] ?? "";
		const processors = [
			"Anthropic",
			"Google",
			"Places",
			"Firebase Cloud Messaging",
			"Apple",
			"Sign in with Apple",
			"Duffel",
			"Booking.com",
			"Ticketmaster",
			"Eventbrite",
			"Resend",
			"Cloudflare",
			"Frankfurter",
		];
		const flat = para.replace(/\s+/g, " ");
		for (const name of processors) expect(flat, `doc lists ${name}`).toContain(name);
		const t = text(render("/privacy"));
		for (const name of processors) expect(t, `privacy names ${name}`).toContain(name);
		// APNs, spelled out on the page.
		expect(flat).toContain("APNs");
		expect(t).toContain("Apple Push Notification service");
	});

	// Deliberate current state: the owner replaces {{CONTROLLER}} before submission.
	// When that happens, update this one assertion.
	it("PLACEHOLDER: privacy and terms still show {{CONTROLLER}} visibly marked", () => {
		for (const p of ["/privacy", "/terms"])
			expect(render(p), p).toContain('<mark class="legal-fill">{{CONTROLLER}}</mark>');
	});
});
