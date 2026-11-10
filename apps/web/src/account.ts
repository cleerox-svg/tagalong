/**
 * The account page's pure logic (spec §9 phase 7): the typed confirmation for
 * deleting an account, what to say when it fails, and provider names.
 * No I/O, so it is unit-tested without a DOM.
 */
import type { AuthProvider, DeleteAccountRequest } from "@tagalong/shared";
import { ApiError, type Me } from "./api.js";

/** The word the person types, and the API's literal `confirm` value. */
export const DELETE_CONFIRM_WORD: DeleteAccountRequest["confirm"] = "DELETE";

/**
 * True only when the person typed the word exactly (surrounding spaces from a
 * phone keyboard are forgiven; case and anything else are not).
 */
export function isDeleteConfirmed(typed: string): boolean {
	return typeof typed === "string" && typed.trim() === DELETE_CONFIRM_WORD;
}

/** What a failed delete tells the person. Never echoes server text. */
export function deleteErrorMessage(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.status === 401)
			return "You've been signed out. Sign in again, then delete your account from this page.";
		if (err.status === 429) return "Too many attempts. Try again in an hour.";
		return "We couldn't delete your account just now. Try again.";
	}
	return "That didn't go through. Check your connection and try again.";
}

const PROVIDER_LABELS: Record<AuthProvider, string> = { google: "Google", apple: "Apple" };

/** "Google", "Apple", or "Google and Apple"; null when the API didn't say. */
export function providersLabel(providers: readonly AuthProvider[] | undefined): string | null {
	const names = [...new Set(providers ?? [])]
		.filter((p): p is AuthProvider => Object.hasOwn(PROVIDER_LABELS, p))
		.map((p) => PROVIDER_LABELS[p]);
	if (names.length === 0) return null;
	return names.length === 1
		? (names[0] ?? null)
		: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Who "Signed in as" names: the email, else the display name. Apple can hide
 * the email entirely, so say so rather than leave the person guessing.
 */
export function signedInAs(me: Pick<Me, "email" | "display_name" | "sign_in_providers">): string {
	const email = me.email?.trim() ?? "";
	if (email) return email;
	const name = me.display_name?.trim() ?? "";
	const appleHidden = me.sign_in_providers?.includes("apple") ?? false;
	if (!appleHidden) return name;
	return name ? `${name} (Apple ID, email hidden)` : "Apple ID, email hidden";
}
