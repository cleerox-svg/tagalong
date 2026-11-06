import { ALLOWED_ORIGINS } from "./security.js";

/** The production web origin, for links in share URLs and emails. */
export const WEB_ORIGIN = ALLOWED_ORIGINS[0] as string;

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url: unguessable, URL-safe, 43 characters. */
export function newShareToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export const shareUrl = (token: string) => `${WEB_ORIGIN}/s/${token}`;
