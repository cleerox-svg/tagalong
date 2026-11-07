import { describe, expect, it } from "vitest";
import {
	ConnectRequestSchema,
	containsUrl,
	InterestSchema,
	JoinGroupSchema,
	MessageBodySchema,
	messageCursor,
	ModResolveSchema,
	parseMessageCursor,
	ReportInputSchema,
	TagalongOptInSchema,
} from "./tagalong.js";

describe("containsUrl", () => {
	it("finds schemes, www. and bare domains", () => {
		for (const t of [
			"see http://x.y",
			"HTTPS://example.com/a",
			"go to www.example",
			"example.com",
			"tickets at foo.bar.co.uk tonight",
			"my site: scam.xyz/page",
			"dm me on t.me", // two-letter TLD
			"mail bob@example.org",
			"(example.com)",
		]) {
			expect(containsUrl(t), t).toBe(true);
		}
	});

	it("leaves ordinary chat alone", () => {
		for (const t of [
			"Meet at 7.30 by gate B",
			"e.g. pre-game food",
			"It costs 3.50 each",
			"St. Louis or Washington, D.C.",
			"See you there!",
			"a.m. or p.m.",
			"",
		]) {
			expect(containsUrl(t), t).toBe(false);
		}
	});
});

describe("TagalongOptInSchema", () => {
	const ok = { confirm: true, name: "  Sam  ", city: " Toronto, ON " };

	it("accepts and trims a name and city label", () => {
		expect(TagalongOptInSchema.parse(ok)).toEqual({
			confirm: true,
			name: "Sam",
			city: "Toronto, ON",
		});
		for (const city of ["St. John's", "Winston-Salem", "Montréal", "Québec (City)", "東京"]) {
			expect(TagalongOptInSchema.safeParse({ ...ok, city }).success, city).toBe(true);
		}
	});

	it("requires confirm: true", () => {
		expect(TagalongOptInSchema.safeParse({ ...ok, confirm: false }).success).toBe(false);
		expect(TagalongOptInSchema.safeParse({ name: "Sam", city: "Toronto" }).success).toBe(false);
	});

	it("rejects coordinates, addresses, postal codes and links as a city", () => {
		for (const city of [
			"43.65, -79.38",
			"43.6532,-79.3832",
			"123 Main St, Toronto",
			"M5V 2T6",
			"Toronto 2",
			"evil.com",
			"",
			"   ",
			"x".repeat(81),
		]) {
			expect(TagalongOptInSchema.safeParse({ ...ok, city }).success, city).toBe(false);
		}
	});

	it("bounds the name and refuses links or control characters in it", () => {
		expect(TagalongOptInSchema.safeParse({ ...ok, name: "x".repeat(40) }).success).toBe(true);
		for (const name of ["", "  ", "x".repeat(41), "bob@example.com", "a‮b", "a\nb"]) {
			expect(TagalongOptInSchema.safeParse({ ...ok, name }).success, name).toBe(false);
		}
	});
});

describe("InterestSchema / JoinGroupSchema", () => {
	it("is optional, nullable, trimmed, empty to null, and capped at 140", () => {
		expect(JoinGroupSchema.parse({})).toEqual({});
		expect(JoinGroupSchema.parse({ interest: null })).toEqual({ interest: null });
		expect(InterestSchema.parse("  ")).toBeNull();
		expect(InterestSchema.parse(" pre-game food ")).toBe("pre-game food");
		expect(InterestSchema.safeParse("x".repeat(140)).success).toBe(true);
		expect(InterestSchema.safeParse("x".repeat(141)).success).toBe(false);
	});

	it("refuses links and e-mail addresses (shown to every member)", () => {
		for (const t of [
			"see http://x.y",
			"www.example",
			"tickets at scam.xyz",
			"dm me on t.me",
			"mail bob@example.org",
		]) {
			const r = InterestSchema.safeParse(t);
			expect(r.success, t).toBe(false);
			if (!r.success) expect(r.error.issues[0]?.message).toMatch(/links/);
			expect(JoinGroupSchema.safeParse({ interest: t }).success, t).toBe(false);
		}
		expect(InterestSchema.parse("Meet at 7.30 by gate B")).toBe("Meet at 7.30 by gate B");
	});

	it("refuses control, zero-width and bidi characters", () => {
		for (const t of [
			"a\nb",
			"a\tb",
			"a\u0085b",
			"a\u200bb",
			"a\u200fb",
			"a\u202eb",
			"a\u2066b",
			"a\u2060b",
			"a\ufeffb",
			"a\u061cb",
		]) {
			expect(InterestSchema.safeParse(t).success, JSON.stringify(t)).toBe(false);
		}
	});
});

describe("MessageBodySchema", () => {
	it("trims and bounds 1 to 1000", () => {
		expect(MessageBodySchema.parse("  hi ")).toBe("hi");
		expect(MessageBodySchema.safeParse("   ").success).toBe(false);
		expect(MessageBodySchema.safeParse("x".repeat(1000)).success).toBe(true);
		expect(MessageBodySchema.safeParse("x".repeat(1001)).success).toBe(false);
	});

	it("keeps line breaks and normalises CRLF / CR to LF", () => {
		expect(MessageBodySchema.parse("line one\nline two")).toBe("line one\nline two");
		expect(MessageBodySchema.parse("a\r\nb\rc")).toBe("a\nb\nc");
		expect(MessageBodySchema.parse("\r\n hi \r\n")).toBe("hi");
		expect(MessageBodySchema.safeParse("\r\n\r\n").success).toBe(false);
	});

	it("refuses other controls and zero-width / bidi characters with a clear message", () => {
		for (const t of [
			"a\u0000b",
			"a\tb",
			"a\u000bb",
			"a\u000cb",
			"a\u001bb",
			"a\u007fb",
			"a\u0085b",
			"a\u009fb",
			"a\u200bb",
			"a\u200cb",
			"a\u200db",
			"a\u200eb",
			"a\u200fb",
			"a\u202ab",
			"a\u202eb",
			"a\u2066b",
			"a\u2069b",
			"a\ufeffb",
		]) {
			const r = MessageBodySchema.safeParse(t);
			expect(r.success, JSON.stringify(t)).toBe(false);
			if (!r.success) expect(r.error.issues[0]?.message).toMatch(/line breaks are fine/);
		}
	});

	it("still accepts ordinary non-ASCII text and emoji", () => {
		for (const t of ["Montréal ce soir?", "東京で会おう", "مرحبا", "see you \u{1F44B}"]) {
			expect(MessageBodySchema.parse(t)).toBe(t);
		}
	});
});

describe("messageCursor / parseMessageCursor", () => {
	it("round-trips seq as decimal", () => {
		for (const seq of [0, 1, 42, 1_000_000, Number.MAX_SAFE_INTEGER]) {
			const c = messageCursor({ seq });
			expect(c).toBe(String(seq));
			expect(parseMessageCursor(c)).toBe(seq);
		}
	});

	it("returns null for anything but a non-negative safe decimal integer", () => {
		for (const s of [
			"",
			" 1",
			"1 ",
			"-1",
			"+1",
			"01",
			"00",
			"1.0",
			"1e3",
			"0x10",
			"1_000",
			"NaN",
			"Infinity",
			"abc",
			"2026-11-07T00:00:00Z|m1",
			"9007199254740992", // MAX_SAFE_INTEGER + 1
			"99999999999999999", // 17 digits
			"1".repeat(1000),
			"\u0661", // Arabic-Indic digit one
		]) {
			expect(parseMessageCursor(s), JSON.stringify(s)).toBeNull();
		}
	});
});

describe("ReportInputSchema", () => {
	const ok = { target_type: "message", target_id: "m1", reason: "spam" };

	it("accepts message and user targets with the migration's reasons", () => {
		expect(ReportInputSchema.safeParse(ok).success).toBe(true);
		for (const reason of ["spam", "harassment", "safety", "inappropriate", "other"]) {
			expect(
				ReportInputSchema.safeParse({ ...ok, target_type: "user", reason }).success,
				reason,
			).toBe(true);
		}
	});

	it("rejects 'post', unknown reasons and long details", () => {
		expect(ReportInputSchema.safeParse({ ...ok, target_type: "post" }).success).toBe(false);
		expect(ReportInputSchema.safeParse({ ...ok, reason: "rude" }).success).toBe(false);
		expect(ReportInputSchema.safeParse({ ...ok, details: "x".repeat(1001) }).success).toBe(false);
		expect(ReportInputSchema.parse({ ...ok, details: "  " }).details).toBeNull();
	});
});

describe("ConnectRequestSchema / ModResolveSchema", () => {
	it("validates ids and actions", () => {
		expect(ConnectRequestSchema.safeParse({ user_id: "u1" }).success).toBe(true);
		expect(ConnectRequestSchema.safeParse({ user_id: "" }).success).toBe(false);
		for (const action of ["dismiss", "remove_message", "suspend_user"]) {
			expect(ModResolveSchema.safeParse({ action }).success).toBe(true);
		}
		expect(ModResolveSchema.safeParse({ action: "ban" }).success).toBe(false);
	});
});
