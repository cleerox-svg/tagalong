import { DeleteAccountRequestSchema } from "@tagalong/shared";
import { describe, expect, it } from "vitest";
import {
	DELETE_CONFIRM_WORD,
	deleteErrorMessage,
	isDeleteConfirmed,
	providersLabel,
} from "./account.js";
import { ApiError } from "./api.js";

describe("typed delete confirmation", () => {
	it("is the word the API expects", () => {
		expect(DeleteAccountRequestSchema.safeParse({ confirm: DELETE_CONFIRM_WORD }).success).toBe(
			true,
		);
	});

	it("accepts exactly DELETE, forgiving only surrounding spaces", () => {
		expect(isDeleteConfirmed("DELETE")).toBe(true);
		expect(isDeleteConfirmed("  DELETE ")).toBe(true);
	});

	it("rejects anything else", () => {
		for (const typed of ["", "delete", "Delete", "DELET", "DELETE!", "DELETE ME", "D E L E T E"])
			expect(isDeleteConfirmed(typed), typed).toBe(false);
		expect(isDeleteConfirmed(undefined as unknown as string)).toBe(false);
	});
});

describe("deleteErrorMessage", () => {
	it("explains each failure without echoing server text", () => {
		const server = (status: number) => new ApiError(status, "x", "<b>server says</b>");
		expect(deleteErrorMessage(server(401))).toMatch(/signed out/);
		expect(deleteErrorMessage(server(429))).toMatch(/Too many/);
		expect(deleteErrorMessage(server(500))).toMatch(/Try again/);
		for (const s of [400, 401, 429, 500])
			expect(deleteErrorMessage(server(s))).not.toContain("server says");
		expect(deleteErrorMessage(new TypeError("Failed to fetch"))).toMatch(/connection/);
	});
});

describe("providersLabel", () => {
	it("names the sign-in providers", () => {
		expect(providersLabel(["google"])).toBe("Google");
		expect(providersLabel(["apple"])).toBe("Apple");
		expect(providersLabel(["google", "apple"])).toBe("Google and Apple");
		expect(providersLabel(["apple", "apple"])).toBe("Apple");
	});

	it("is null when the API didn't say", () => {
		expect(providersLabel(undefined)).toBeNull();
		expect(providersLabel([])).toBeNull();
	});
});
