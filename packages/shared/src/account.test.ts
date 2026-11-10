import { describe, expect, it } from "vitest";
import {
	APPLE_USER_NAME_MAX,
	AppleFirstSignInUserSchema,
	appleDisplayName,
	AUTH_PROVIDERS,
	AuthProviderSchema,
	DeleteAccountRequestSchema,
	hasControlChars,
} from "./index.js";

describe("DeleteAccountRequestSchema", () => {
	it("accepts exactly { confirm: 'DELETE' }", () => {
		expect(DeleteAccountRequestSchema.parse({ confirm: "DELETE" })).toEqual({ confirm: "DELETE" });
	});

	it.each([
		["lowercase", { confirm: "delete" }],
		["padded", { confirm: " DELETE" }],
		["boolean", { confirm: true }],
		["empty string", { confirm: "" }],
		["missing", {}],
		["extra key", { confirm: "DELETE", user_id: "u1" }],
		["null body", null],
		["string body", "DELETE"],
	])("refuses %s", (_label, body) => {
		expect(DeleteAccountRequestSchema.safeParse(body).success).toBe(false);
	});
});

describe("auth providers", () => {
	it("lists google and apple, in order", () => {
		expect([...AUTH_PROVIDERS]).toEqual(["google", "apple"]);
	});

	it("parses known providers and refuses others", () => {
		expect(AuthProviderSchema.parse("apple")).toBe("apple");
		expect(AuthProviderSchema.parse("google")).toBe("google");
		for (const bad of ["Apple", "facebook", "", null, undefined]) {
			expect(AuthProviderSchema.safeParse(bad).success).toBe(false);
		}
	});
});

describe("AppleFirstSignInUserSchema", () => {
	it("trims strings and strips unknown keys at both levels", () => {
		const parsed = AppleFirstSignInUserSchema.parse({
			name: { firstName: "  Ada ", lastName: "Lovelace  ", middleName: "X" },
			email: " ada@privaterelay.appleid.com ",
			is_private_email: true,
		});
		expect(parsed).toEqual({
			name: { firstName: "Ada", lastName: "Lovelace" },
			email: "ada@privaterelay.appleid.com",
		});
	});

	it("accepts an empty object and a missing name", () => {
		expect(AppleFirstSignInUserSchema.parse({})).toEqual({});
		expect(AppleFirstSignInUserSchema.parse({ email: "a@b.co" })).toEqual({ email: "a@b.co" });
	});

	it("accepts a name part of exactly the max and refuses one over it", () => {
		const max = "a".repeat(APPLE_USER_NAME_MAX);
		expect(AppleFirstSignInUserSchema.safeParse({ name: { firstName: max } }).success).toBe(true);
		expect(AppleFirstSignInUserSchema.safeParse({ name: { lastName: `${max}a` } }).success).toBe(
			false,
		);
	});

	it("measures the max after trimming", () => {
		const padded = ` ${"a".repeat(APPLE_USER_NAME_MAX)} `;
		expect(AppleFirstSignInUserSchema.safeParse({ name: { firstName: padded } }).success).toBe(
			true,
		);
	});

	it("refuses wrong types", () => {
		for (const bad of [
			{ name: "Ada Lovelace" },
			{ name: { firstName: 1 } },
			{ name: { firstName: null } },
			{ email: 5 },
			null,
			"user",
		]) {
			expect(AppleFirstSignInUserSchema.safeParse(bad).success).toBe(false);
		}
	});
});

describe("appleDisplayName", () => {
	it("joins first and last", () => {
		expect(appleDisplayName({ name: { firstName: "Ada", lastName: "Lovelace" } })).toBe(
			"Ada Lovelace",
		);
	});

	it("uses only the first or only the last name when the other is missing", () => {
		expect(appleDisplayName({ name: { firstName: "Ada" } })).toBe("Ada");
		expect(appleDisplayName({ name: { lastName: "Lovelace" } })).toBe("Lovelace");
		expect(appleDisplayName({ name: { firstName: "", lastName: "Lovelace" } })).toBe("Lovelace");
	});

	it("is null with no user, no name, or an empty name", () => {
		expect(appleDisplayName(undefined)).toBeNull();
		expect(appleDisplayName({})).toBeNull();
		expect(appleDisplayName({ email: "a@b.co" })).toBeNull();
		expect(appleDisplayName({ name: {} })).toBeNull();
		expect(appleDisplayName({ name: { firstName: "", lastName: "" } })).toBeNull();
		expect(appleDisplayName({ name: { firstName: "   ", lastName: " " } })).toBeNull();
	});

	it("collapses runs of spaces, including non-breaking ones", () => {
		expect(appleDisplayName({ name: { firstName: "  Mary   Ann ", lastName: " Smith" } })).toBe(
			"Mary Ann Smith",
		);
		expect(appleDisplayName({ name: { firstName: "Ada  B" } })).toBe("Ada B");
	});

	it("is null when a part holds a control or invisible character", () => {
		for (const bad of ["Ada\u0000", "Ada\nLovelace", "Ada\tL", "‮Ada", "A​da", "Ada\u0085"]) {
			expect(appleDisplayName({ name: { firstName: bad } })).toBeNull();
			expect(appleDisplayName({ name: { firstName: "Ok", lastName: bad } })).toBeNull();
		}
	});

	it("accepts exactly the max and is null when the joined name is longer", () => {
		const half = "a".repeat(30);
		expect(appleDisplayName({ name: { firstName: "a".repeat(APPLE_USER_NAME_MAX) } })).toHaveLength(
			APPLE_USER_NAME_MAX,
		);
		// 30 + space + 30 = 61: each part is valid but the whole is too long.
		expect(appleDisplayName({ name: { firstName: half, lastName: half } })).toBeNull();
		expect(appleDisplayName({ name: { firstName: half, lastName: "a".repeat(29) } })).toHaveLength(
			APPLE_USER_NAME_MAX,
		);
	});

	it("keeps non-Latin names", () => {
		expect(appleDisplayName({ name: { firstName: "山田", lastName: "太郎" } })).toBe("山田 太郎");
	});

	it("works on the output of the schema", () => {
		const user = AppleFirstSignInUserSchema.parse({
			name: { firstName: " Ada ", lastName: " Lovelace " },
		});
		expect(appleDisplayName(user)).toBe("Ada Lovelace");
	});
});

describe("hasControlChars", () => {
	it("flags controls and invisibles, not ordinary text", () => {
		expect(hasControlChars("Ada Lovelace")).toBe(false);
		expect(hasControlChars("Ada\u0007")).toBe(true);
		expect(hasControlChars("﻿Ada")).toBe(true);
	});
});
