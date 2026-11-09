/**
 * `/auth/app-callback` opened in a browser (spec §9 phase 7). The API sends
 * the native app here after sign-in; Android App Links / iOS Universal Links
 * hand the link to the app. When the app isn't installed or the link isn't
 * verified, the browser lands here instead. The one-time code is useless
 * without the app's PKCE verifier, but we still never show it, never keep it
 * in history and never exchange it.
 */
import { useLayoutEffect } from "react";
import { linkTo } from "./router.js";

export const APP_CALLBACK_PATH = "/auth/app-callback";

/**
 * Every error code the API's native sign-in can send here (apps/api/src/auth:
 * nativeErrorPage, fed by HttpError codes from routes.ts, apple.ts and the rate
 * limiter), each with a short, fixed reason. Anything else shows the generic page.
 */
const KNOWN_ERRORS = {
	cancelled: "Sign-in was cancelled.",
	bad_state: "The sign-in took too long or was started somewhere else.",
	bad_request: "The sign-in request wasn't valid.",
	misconfigured: "Sign-in isn't available right now.",
	rate_limited: "There were too many sign-in attempts. Wait a minute first.",
	internal: "Something went wrong on our side.",
	account_deleted: "This account was deleted.",
	google_token_failed: "Google didn't confirm the sign-in.",
	google_bad_token: "Google couldn't verify the account.",
	apple_token_failed: "Apple didn't confirm the sign-in.",
	apple_keys_failed: "Apple didn't confirm the sign-in.",
	apple_bad_token: "Apple couldn't verify the account.",
} as const;

export type AppCallbackErrorCode = keyof typeof KNOWN_ERRORS;

/**
 * What the callback URL said, captured before it is stripped: no error,
 * a known error code, or "generic" for any error we don't recognise. The raw
 * parameter value is never kept.
 */
export type AppCallbackOutcome =
	{ error: false } | { error: true; code: AppCallbackErrorCode | "generic" };

let outcome: AppCallbackOutcome = { error: false };

/** The outcome captured by the last `stripAppCallbackParams()` that saw params. */
export function appCallbackOutcome(): AppCallbackOutcome {
	return outcome;
}

/** A short, fixed reason for a known code; null for "generic". */
export function appCallbackErrorReason(code: AppCallbackErrorCode | "generic"): string | null {
	return code === "generic" ? null : KNOWN_ERRORS[code];
}

function readOutcome(search: string, hash: string): AppCallbackOutcome {
	const params = new URLSearchParams(search);
	let raw = params.get("error");
	if (raw === null && hash.length > 1) raw = new URLSearchParams(hash.slice(1)).get("error");
	if (raw === null) return { error: false };
	const code = Object.hasOwn(KNOWN_ERRORS, raw) ? (raw as AppCallbackErrorCode) : "generic";
	return { error: true, code };
}

/**
 * Note whether the callback carried an error (allowlisted codes only), then
 * drop the query and fragment (the code or error) from the address bar and
 * the history entry. Idempotent; a no-op on any other path.
 */
export function stripAppCallbackParams(): void {
	try {
		const { pathname, search, hash } = window.location;
		if (pathname !== APP_CALLBACK_PATH || (search === "" && hash === "")) return;
		outcome = readOutcome(search, hash);
		window.history.replaceState(null, "", pathname);
	} catch {
		// No history API: nothing kept to strip.
	}
}

export function AppCallback() {
	// Before paint as well as in main.tsx, in case we got here some other way.
	useLayoutEffect(stripAppCallbackParams, []);
	const result = appCallbackOutcome();
	if (result.error) {
		const reason = appCallbackErrorReason(result.code);
		return (
			<section className="card">
				<h1>Sign-in didn't finish</h1>
				<p>
					{reason && <>{reason} </>}
					Close this page and try again in the Budgetrip app.
				</p>
				<p>Using Budgetrip in this browser instead? Sign in from the home page.</p>
				<a className="button primary" href="/" onClick={linkTo("/")}>
					Go to the home page
				</a>
			</section>
		);
	}
	return (
		<section className="card">
			<h1>Open the Budgetrip app to finish signing in</h1>
			<p>
				This sign-in link is meant for the Budgetrip app on your phone. Go back to the app to finish
				signing in. If the app didn't open, make sure it's installed and up to date, then start
				signing in from the app again.
			</p>
			<p>Using Budgetrip in this browser instead? Sign in from the home page.</p>
			<a className="button primary" href="/" onClick={linkTo("/")}>
				Go to the home page
			</a>
		</section>
	);
}
