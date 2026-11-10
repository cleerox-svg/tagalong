/**
 * Suspension evasion guard (phase 7 follow-up). When a suspended user deletes
 * their account, a keyed hash of each sign-in identity it had is kept in
 * suspended_identities (migration 0010); a NEW account created by the same
 * Google or Apple identity starts suspended.
 *
 * id_hash = base64url HMAC-SHA256("google:<sub>" | "apple:<sub>"), keyed by
 * HKDF-SHA256(SESSION_SECRET, info "tagalong:suspended-id:v1") (the same
 * derivation pattern as the Apple refresh-token key). Raw subs are never
 * stored.
 */
import { b64url, secret } from "./session.js";

const INFO = "tagalong:suspended-id:v1";
const enc = new TextEncoder();

export type IdentityProvider = "google" | "apple";

async function idKey(env: Env): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", enc.encode(secret(env)), "HKDF", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(INFO) },
		base,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign"],
	);
}

export async function identityHash(
	env: Env,
	provider: IdentityProvider,
	sub: string,
): Promise<string> {
	return b64url(
		await crypto.subtle.sign("HMAC", await idKey(env), enc.encode(`${provider}:${sub}`)),
	);
}

/** google_sub sentinels (migration 0009): Apple-only and deleted accounts. */
export const isRealGoogleSub = (googleSub: string) =>
	!googleSub.startsWith("apple:") && !googleSub.startsWith("deleted:");

/** The identity hashes of an account, for the deletion batch. */
export async function accountIdentityHashes(
	env: Env,
	u: { google_sub: string; apple_sub: string | null },
): Promise<string[]> {
	const out: string[] = [];
	if (isRealGoogleSub(u.google_sub)) out.push(await identityHash(env, "google", u.google_sub));
	if (u.apple_sub) out.push(await identityHash(env, "apple", u.apple_sub));
	return out;
}

/** SQL value for a new user's tagalong_suspended_at: the stored suspension for `?` (an id_hash), or NULL. */
export const SUSPENDED_AT_FOR_HASH =
	"(SELECT suspended_at FROM suspended_identities WHERE id_hash = ?)";
