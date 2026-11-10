import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import storeListingRaw from "../../../docs/STORE_LISTING.md?raw";
import { DELETE_CONFIRM_WORD } from "./account.js";
import { isLegalPath, LEGAL_PAGES, LegalLinks, legalPage, SUPPORT_EMAIL } from "./Legal.js";
import { canonicalLegalPath, shouldLoadSession } from "./legal-path.js";

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

	// Deliberate current state: the owner replaces {{CONTROLLER}} and {{EFFECTIVE_DATE}}
	// before submission. When that happens, update this one assertion.
	it("PLACEHOLDER: privacy and terms still show {{CONTROLLER}} and {{EFFECTIVE_DATE}} visibly marked", () => {
		for (const p of ["/privacy", "/terms"])
			for (const fill of ["{{CONTROLLER}}", "{{EFFECTIVE_DATE}}"])
				expect(render(p), `${p} ${fill}`).toContain(`<mark class="legal-fill">${fill}</mark>`);
	});

	it("a trailing-slash path renders the same page", () => {
		expect(render("/privacy/")).toBe(render("/privacy"));
		expect(render("/privacy/")).toContain(`<h1 id="legal-h">${LEGAL_PAGES["/privacy"]}</h1>`);
		expect(render("/terms//")).toBe(render("/terms"));
	});

	it("terms disclose affiliate links and send flights to a flight search", () => {
		const t = text(render("/terms"));
		expect(t).toContain("affiliate links");
		expect(t).toContain("flights to a flight search");
		expect(text(render("/support"))).toContain("flights to a flight search");
	});

	it("no page claims every item links to the seller", () => {
		for (const p of PATHS) {
			const t = text(render(p));
			expect(t, p).not.toContain("Each item links to the seller");
			expect(t.toLowerCase(), p).not.toContain("each item links to the seller");
		}
	});

	it("privacy and delete-account say backups last up to 30 days", () => {
		for (const p of ["/privacy", "/delete-account"]) {
			const t = text(render(p));
			expect(t, p).toContain("backups");
			expect(t, p).toContain("up to 30 days");
			expect(t, p).toMatch(/backups[^.]*up to 30 days/);
		}
	});
});

describe("canonicalLegalPath", () => {
	it("returns the canonical path, ignoring trailing slashes", () => {
		for (const p of PATHS) {
			expect(canonicalLegalPath(p), p).toBe(p);
			expect(canonicalLegalPath(`${p}/`), `${p}/`).toBe(p);
			expect(canonicalLegalPath(`${p}//`), `${p}//`).toBe(p);
			expect(isLegalPath(`${p}/`), `${p}/`).toBe(true);
			expect(isLegalPath(`${p}///`), `${p}///`).toBe(true);
		}
	});

	it("still rejects case variants, prototype keys, the root and the empty path", () => {
		for (const p of [
			"/Privacy",
			"/Privacy/",
			"/TERMS/",
			"/__proto__",
			"/__proto__/",
			"/toString/",
			"/constructor/",
			"/hasOwnProperty//",
			"/",
			"//",
			"",
			"/privacy/x/",
		]) {
			expect(canonicalLegalPath(p), p).toBeNull();
			expect(isLegalPath(p), p).toBe(false);
		}
	});
});

describe("shouldLoadSession", () => {
	it("never reads the session on a legal page, with or without a trailing slash", () => {
		for (const p of PATHS)
			for (const path of [p, `${p}/`, `${p}//`]) {
				expect(shouldLoadSession(path, false), path).toBe(false);
				expect(shouldLoadSession(path, true), path).toBe(false);
			}
	});

	it("reads it on any other page when not yet started", () => {
		for (const p of ["/", "", "/trips", "/account", "/Privacy", "/__proto__", "/privacy-policy"])
			expect(shouldLoadSession(p, false), p).toBe(true);
	});

	it("never reads it again once started", () => {
		for (const p of ["/", "/trips", "/account", "/privacy", "/privacy/"])
			expect(shouldLoadSession(p, true), p).toBe(false);
	});
});

describe("LegalLinks", () => {
	const links = (path: string) => renderToStaticMarkup(createElement(LegalLinks, { path }));
	/** The hrefs of links marked aria-current="page". */
	const current = (html: string) =>
		[...html.matchAll(/<a\b[^>]*>/g)]
			.map((m) => m[0])
			.filter((a) => a.includes('aria-current="page"'))
			.map((a) => /href="([^"]+)"/.exec(a)?.[1]);

	it("marks only the Privacy link on /privacy and /privacy/", () => {
		for (const path of ["/privacy", "/privacy/"]) {
			const html = links(path);
			expect(current(html), path).toEqual(["/privacy"]);
			expect(html.match(/aria-current=/g), path).toHaveLength(1);
		}
		expect(current(links("/terms/"))).toEqual(["/terms"]);
	});

	it("marks no link on / or a non-legal page", () => {
		for (const path of ["/", "/trips", "/delete-account"]) {
			const html = links(path);
			expect(html, path).not.toContain("aria-current");
			expect(html.match(/<a\b/g), path).toHaveLength(3);
		}
	});
});
