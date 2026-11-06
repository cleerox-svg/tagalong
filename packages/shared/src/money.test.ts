import { describe, expect, it } from "vitest";
import {
	convertMinor,
	currencyExponent,
	FxTable,
	formatMoney,
	MissingRateError,
	parseMajor,
} from "./money.js";

describe("currencyExponent", () => {
	it("knows 0- and 3-decimal currencies and defaults to 2", () => {
		expect(currencyExponent("JPY")).toBe(0);
		expect(currencyExponent("KWD")).toBe(3);
		expect(currencyExponent("CAD")).toBe(2);
	});
	it("rejects non-ISO codes", () => {
		expect(() => currencyExponent("cad")).toThrow(RangeError);
	});
});

describe("parseMajor", () => {
	it("parses without float error", () => {
		expect(parseMajor("1,200", "CAD")).toBe(120000);
		expect(parseMajor("0.29", "USD")).toBe(29);
		expect(parseMajor("19.99", "USD")).toBe(1999);
		expect(parseMajor("5000", "JPY")).toBe(5000);
	});
	it("rejects more decimals than the currency has", () => {
		expect(() => parseMajor("10.5", "JPY")).toThrow(RangeError);
		expect(() => parseMajor("-3", "USD")).toThrow(RangeError);
	});
});

describe("convertMinor", () => {
	it("rounds up so a converted cost is never understated", () => {
		// 1.00 USD at 1.3333 CAD = 133.33 -> 134 cents
		expect(convertMinor(100, "USD", "CAD", 1.3333)).toBe(134);
	});
	it("does not round up binary noise", () => {
		expect(convertMinor(300, "USD", "EUR", 0.1)).toBe(30);
	});
	it("handles exponent changes", () => {
		// 10.00 USD -> JPY at 150 = 1500 yen
		expect(convertMinor(1000, "USD", "JPY", 150)).toBe(1500);
		// 1500 JPY -> USD at 1/150 = 10.00
		expect(convertMinor(1500, "JPY", "USD", 1 / 150)).toBe(1000);
	});
	it("is the identity for the same currency", () => {
		expect(convertMinor(12345, "GBP", "GBP", 99)).toBe(12345);
	});
});

describe("FxTable", () => {
	const fx = new FxTable([
		{ base: "USD", quote: "CAD", rate: 1.4, as_of: "2026-11-05" },
		{ base: "USD", quote: "GBP", rate: 0.8, as_of: "2026-11-04" },
	]);
	it("uses direct, inverse and cross rates, with the older date", () => {
		expect(fx.find("USD", "CAD")?.rate).toBe(1.4);
		expect(fx.find("CAD", "USD")?.rate).toBeCloseTo(1 / 1.4);
		const cross = fx.find("CAD", "GBP");
		expect(cross?.rate).toBeCloseTo(0.8 / 1.4);
		expect(cross?.as_of).toBe("2026-11-04");
	});
	it("throws a typed error when no rate exists", () => {
		expect(() => fx.convert({ amount_minor: 1, currency: "JPY" }, "CAD")).toThrow(MissingRateError);
	});
});

describe("formatMoney", () => {
	it("formats minor units", () => {
		expect(formatMoney({ amount_minor: 120000, currency: "CAD" }, "en-CA")).toBe("$1,200.00");
	});
});
