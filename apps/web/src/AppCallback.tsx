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
 * Drop the query and fragment (the code or error) from the address bar and
 * the history entry. Idempotent; a no-op on any other path.
 */
export function stripAppCallbackParams(): void {
	try {
		const { pathname, search, hash } = window.location;
		if (pathname !== APP_CALLBACK_PATH || (search === "" && hash === "")) return;
		window.history.replaceState(null, "", pathname);
	} catch {
		// No history API: nothing kept to strip.
	}
}

export function AppCallback() {
	// Before paint as well as in main.tsx, in case we got here some other way.
	useLayoutEffect(stripAppCallbackParams, []);
	return (
		<section className="card">
			<h1>Finish signing in in the Budgetrip app</h1>
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
