/**
 * Account (BUILD_SPEC §9 phase 7, store readiness): sign-in providers, in-app
 * account deletion and Sign in with Apple's first-sign-in `user` payload.
 * Pure: no I/O, no clock, no randomness.
 */
import { z } from "zod";
import { hasControlChars } from "./tagalong.js";

// ---------------------------------------------------------------------------
// Sign-in providers.
// ---------------------------------------------------------------------------

export const AUTH_PROVIDERS = ["google", "apple"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export const AuthProviderSchema = z.enum(AUTH_PROVIDERS);

/** The providers linked to an account, as listed on GET /me (`sign_in_providers`). */
export type SignInProviders = AuthProvider[];

// ---------------------------------------------------------------------------
// Account deletion. The client must send the literal word, so a stray or
// replayed empty POST can never delete an account.
// ---------------------------------------------------------------------------

export const DeleteAccountRequestSchema = z.strictObject({ confirm: z.literal("DELETE") });
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

// ---------------------------------------------------------------------------
// Sign in with Apple: the `user` JSON Apple posts on the first sign-in only.
// It is NOT signed: treat every field as untrusted input. The account's email
// must come from the verified id_token, never from here.
// ---------------------------------------------------------------------------

export const APPLE_USER_NAME_MAX = 60;
/** RFC 5321 path limit; this email is informational only (see above). */
export const APPLE_USER_EMAIL_MAX = 254;

const appleNamePart = z.string().trim().max(APPLE_USER_NAME_MAX).optional();

/**
 * Not strict: Apple may add fields, which are stripped. A field over its max
 * fails the whole parse; the caller then ignores the payload.
 */
export const AppleFirstSignInUserSchema = z.object({
	name: z.object({ firstName: appleNamePart, lastName: appleNamePart }).optional(),
	email: z.string().trim().max(APPLE_USER_EMAIL_MAX).optional(),
});
export type AppleFirstSignInUser = z.infer<typeof AppleFirstSignInUserSchema>;

/**
 * A display name from Apple's first-sign-in `user`: first and last joined by a
 * space, runs of whitespace collapsed. Null when there is no name, it is empty,
 * it holds a control or invisible character, or it is longer than
 * APPLE_USER_NAME_MAX (rejected, never truncated).
 */
export function appleDisplayName(user: AppleFirstSignInUser | undefined): string | null {
	const first = user?.name?.firstName ?? "";
	const last = user?.name?.lastName ?? "";
	if (hasControlChars(first) || hasControlChars(last)) return null;
	const joined = `${first} ${last}`.replace(/\s+/g, " ").trim();
	if (joined.length === 0 || joined.length > APPLE_USER_NAME_MAX) return null;
	return joined;
}
