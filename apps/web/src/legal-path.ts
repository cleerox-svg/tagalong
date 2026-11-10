/**
 * Which paths are the public legal pages, and when the app reads the session.
 * Plain functions with no React, so they are easy to unit-test.
 */

export const LEGAL_PAGES = {
	"/privacy": "Privacy Policy",
	"/terms": "Terms of Use",
	"/support": "Support",
	"/delete-account": "Delete your account",
} as const;
export type LegalPath = keyof typeof LEGAL_PAGES;

/**
 * The legal page a path names, or null. Case-sensitive; trailing slashes are
 * ignored ("/privacy/" and "/privacy//" are "/privacy"). Own keys only, so
 * "/toString" or "/__proto__" never match.
 */
export function canonicalLegalPath(path: string): LegalPath | null {
	let end = path.length;
	while (end > 0 && path[end - 1] === "/") end--;
	const trimmed = path.slice(0, end);
	return Object.hasOwn(LEGAL_PAGES, trimmed) ? (trimmed as LegalPath) : null;
}

export function isLegalPath(path: string): boolean {
	return canonicalLegalPath(path) !== null;
}

/**
 * Whether to read the session (/me) now. The public legal pages make no
 * account request on a cold load; the session is read once, when the person
 * first reaches any other page.
 */
export function shouldLoadSession(path: string, alreadyStarted: boolean): boolean {
	return !alreadyStarted && !isLegalPath(path);
}
