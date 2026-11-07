import { describe, expect, it } from "vitest";
import {
	ConnectRequestSchema,
	containsUrl,
	InterestSchema,
	JoinGroupSchema,
	MessageBodySchema,
	ModResolveSchema,
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
});

describe("MessageBodySchema", () => {
	it("trims and bounds 1 to 1000", () => {
		expect(MessageBodySchema.parse("  hi ")).toBe("hi");
		expect(MessageBodySchema.safeParse("   ").success).toBe(false);
		expect(MessageBodySchema.safeParse("x".repeat(1000)).success).toBe(true);
		expect(MessageBodySchema.safeParse("x".repeat(1001)).success).toBe(false);
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
