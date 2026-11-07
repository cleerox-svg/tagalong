/**
 * Pasted event links (spec §7: "Pasted URL → page parse"). Reads the page's
 * schema.org Event data (JSON-LD), which most ticketing and venue sites
 * publish for search engines. No AI is involved: every field, and any price,
 * is copied from what the page itself states, and a price is kept only with
 * a currency code next to it.
 *
 * Fetching a URL a user typed is a server-side request on their behalf, so
 * the host is checked first (no IP literals, no internal names, http(s) on
 * default ports), redirects are followed by hand and re-checked, and the
 * body is size- and time-limited.
 */
import { type EventInfo, isCurrencyCode, parseMajor } from "@tagalong/shared";
import { cachedJson, ProviderError } from "../lib/cache.js";

/** What reading one event source produced. `event` is null when nothing usable was found. */
export interface EventRead {
	event: EventInfo | null;
	/** Online-only: there is nowhere to travel to. */
	online: boolean;
	cancelled: boolean;
	/** The page's own title, to pre-fill "tell us the date and city". */
	title: string | null;
}

export class BlockedUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlockedUrlError";
	}
}

/** The host itself or any subdomain of it is refused. */
const BLOCKED_DOMAINS = [
	"localhost",
	"local",
	"internal",
	"lan",
	"home",
	"home.arpa",
	"corp",
	"intranet",
	// Our own hosts: a pasted link must never make the API call itself.
	"averrow.com",
];

/** Throws BlockedUrlError unless `raw` is a public http(s) URL we are willing to fetch. */
export function checkPublicUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new BlockedUrlError("That isn't a link.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new BlockedUrlError("Only http and https links can be read.");
	if (url.username || url.password) throw new BlockedUrlError("Links with a login can't be read.");
	if (url.port && url.port !== "80" && url.port !== "443")
		throw new BlockedUrlError("Links on unusual ports can't be read.");
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host))
		throw new BlockedUrlError("Links to an IP address can't be read.");
	if (!host.includes(".") || host === "localhost")
		throw new BlockedUrlError("That link isn't on the public web.");
	if (BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)))
		throw new BlockedUrlError("That link isn't on the public web.");
	url.hash = "";
	for (const k of [...url.searchParams.keys()])
		if (/^(utm_|fbclid$|gclid$|aff$)/i.test(k)) url.searchParams.delete(k);
	return url;
}

/** Stable id for a page, used as events.provider_event_id. */
export async function urlId(url: URL): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.href));
	return [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 8000;
const USER_AGENT = "Mozilla/5.0 (compatible; BudgetripBot/1.0; +https://tagalong.averrow.com)";

async function readCapped(res: Response): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BYTES) {
			await reader.cancel();
			break;
		}
		chunks.push(value);
	}
	const all = new Uint8Array(Math.min(size, MAX_BYTES));
	let at = 0;
	for (const c of chunks) {
		all.set(c.subarray(0, all.length - at), at);
		at += c.byteLength;
		if (at >= all.length) break;
	}
	return new TextDecoder().decode(all);
}

/** GETs a public page as HTML, re-checking every redirect hop. */
async function fetchHtml(start: URL): Promise<{ html: string; finalUrl: URL }> {
	let url = start;
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let res: Response;
		try {
			res = await fetch(url.href, {
				redirect: "manual",
				signal,
				headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": USER_AGENT },
			});
		} catch {
			throw new ProviderError("event-page", "fetch failed");
		}
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("Location");
			await res.body?.cancel();
			if (!loc) throw new ProviderError("event-page", `HTTP ${res.status} without Location`);
			url = checkPublicUrl(new URL(loc, url).href);
			continue;
		}
		if (!res.ok) {
			await res.body?.cancel();
			throw new ProviderError("event-page", `HTTP ${res.status}`);
		}
		const type = res.headers.get("Content-Type") ?? "";
		if (!/html|xml/i.test(type)) {
			await res.body?.cancel();
			throw new ProviderError("event-page", `not HTML: ${type}`);
		}
		return { html: await readCapped(res), finalUrl: url };
	}
	throw new ProviderError("event-page", "too many redirects");
}

const PAGE_TTL = 30 * 60;

/** Fetches and parses one event page. Throws ProviderError when the page can't be fetched. */
export async function readEventPage(url: URL, opts: { fresh?: boolean } = {}): Promise<EventRead> {
	const id = await urlId(url);
	return cachedJson(
		`page/${id}`,
		PAGE_TTL,
		async () => {
			const { html } = await fetchHtml(url);
			return parseEventPage(html, url.href, id);
		},
		opts,
	);
}

// ---- Parsing (pure; exported for tests) ----

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

function decodeEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

function text(v: unknown, max = 200): string | null {
	if (typeof v !== "string") return null;
	const t = decodeEntities(v.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
	return t ? t.slice(0, max) : null;
}

function types(node: Json): string[] {
	return asArray(node["@type"]).filter((t): t is string => typeof t === "string");
}

const isEventNode = (n: Json) => types(n).some((t) => /(Event|Festival)$/.test(t));

/** Every object in the JSON-LD blocks, including inside @graph and arrays. */
function ldNodes(html: string): Json[] {
	const out: Json[] = [];
	const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
	for (const m of html.matchAll(re)) {
		const raw = (m[1] ?? "")
			.replace(/^\s*<!--/, "")
			.replace(/-->\s*$/, "")
			.replace(/^\s*\/\/<!\[CDATA\[/, "")
			.replace(/\/\/\]\]>\s*$/, "")
			.trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		const stack = asArray(parsed);
		while (stack.length > 0 && out.length < 200) {
			const n = stack.shift();
			if (Array.isArray(n)) stack.push(...n);
			else if (isObj(n)) {
				out.push(n);
				if (n["@graph"]) stack.push(...asArray(n["@graph"]));
			}
		}
	}
	return out;
}

function metaTitle(html: string): string | null {
	const og =
		/<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html) ??
		/<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:title["']/i.exec(html);
	return text(og?.[1]) ?? text(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
}

/** A schema.org price (number or string) → minor units, or null if it isn't a clean amount. */
export function priceToMinor(v: unknown, currency: string): number | null {
	let s: string;
	if (typeof v === "number") {
		if (!Number.isFinite(v) || v < 0) return null;
		s = String(v);
	} else if (typeof v === "string") {
		s = v.trim();
		if (/^free$/i.test(s)) return 0;
		s = s.replace(/^[^\d]+/, "");
	} else return null;
	try {
		return parseMajor(s, currency);
	} catch {
		return null;
	}
}

function priceRange(node: Json): EventInfo["price_range"] {
	const offers: Json[] = [];
	for (const o of asArray(node.offers)) {
		if (!isObj(o)) continue;
		offers.push(o);
		for (const inner of asArray(o.offers)) if (isObj(inner)) offers.push(inner);
	}
	let currency: string | null = null;
	const amounts: number[] = [];
	for (const o of offers) {
		const cur = typeof o.priceCurrency === "string" ? o.priceCurrency.trim().toUpperCase() : "";
		if (!isCurrencyCode(cur)) continue;
		// One currency per event: mixing would need a rate the page doesn't give.
		if (currency && cur !== currency) continue;
		for (const key of ["price", "lowPrice", "highPrice"]) {
			const minor = priceToMinor(o[key], cur);
			if (minor !== null) {
				currency = cur;
				amounts.push(minor);
			}
		}
	}
	if (currency && amounts.length > 0) {
		return {
			min_minor: Math.min(...amounts),
			max_minor: Math.max(...amounts),
			currency,
		};
	}
	if (node.isAccessibleForFree === true || node.isAccessibleForFree === "true")
		return { min_minor: 0, max_minor: 0, currency: "USD" };
	return null;
}

const SCHEMA_CATEGORY: Record<string, string> = {
	MusicEvent: "Music",
	SportsEvent: "Sports",
	TheaterEvent: "Arts & Theatre",
	DanceEvent: "Arts & Theatre",
	ComedyEvent: "Arts & Theatre",
	ScreeningEvent: "Arts & Theatre",
	Festival: "Festival",
};

export function parseEventPage(html: string, pageUrl: string, id: string): EventRead {
	const title = metaTitle(html);
	const node = ldNodes(html).find(
		(n) => isEventNode(n) && text(n.name) && typeof n.startDate === "string",
	);
	if (!node) return { event: null, online: false, cancelled: false, title };

	const name = text(node.name) as string;
	const start = String(node.startDate).trim();
	const localDate = /^(\d{4}-\d{2}-\d{2})/.exec(start)?.[1] ?? null;
	const hasZone = /T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(start);
	const startsAt =
		hasZone && !Number.isNaN(Date.parse(start)) ? new Date(start).toISOString() : null;

	const locations = asArray(node.location).filter(isObj);
	const place =
		locations.find((l) => !types(l).includes("VirtualLocation")) ?? (null as Json | null);
	const online =
		/OnlineEventAttendanceMode/.test(String(node.eventAttendanceMode ?? "")) ||
		(locations.length > 0 && !place);
	const cancelled = /EventCancelled/.test(String(node.eventStatus ?? ""));

	let venue: string | null = null;
	let city: string | null = null;
	let country: string | null = null;
	let lat: number | null = null;
	let lng: number | null = null;
	if (place) {
		venue = text(place.name);
		const addr = place.address;
		if (isObj(addr)) {
			city = text(addr.addressLocality, 100);
			const c = isObj(addr.addressCountry) ? addr.addressCountry.name : addr.addressCountry;
			const code = typeof c === "string" ? c.trim().toUpperCase() : "";
			country = /^[A-Z]{2}$/.test(code) ? code : null;
		} else if (!venue) {
			venue = text(addr);
		}
		if (isObj(place.geo)) {
			const la = Number(place.geo.latitude);
			const lo = Number(place.geo.longitude);
			if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
				lat = la;
				lng = lo;
			}
		}
	}

	const typeCategory = types(node)
		.map((t) => SCHEMA_CATEGORY[t])
		.find(Boolean);

	if (!localDate) return { event: null, online, cancelled, title: name };
	return {
		event: {
			provider: "url",
			provider_event_id: id,
			name,
			category: typeCategory ?? null,
			venue_name: venue,
			city,
			country_code: country,
			lat,
			lng,
			local_date: localDate,
			starts_at: startsAt,
			// The page the details and price were read from: it is the source we
			// name, and it links on to the seller.
			url: pageUrl,
			price_range: priceRange(node),
		},
		online,
		cancelled,
		title: name,
	};
}
