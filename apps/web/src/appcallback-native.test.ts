/**
 * Phase 7: the web side of the verified HTTPS sign-in link.
 * - /auth/app-callback opened in a browser strips the code / error, renders
 *   without echoing them, and never exchanges the code.
 * - parseAuthCallback edge cases not covered in native.test.ts.
 * - nativeAfterAccountDeleted in a browser and with nothing stored.
 * No DOM: `window` is a stub and React renders to a string.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("capacitor-secure-storage-plugin", () => ({
	SecureStoragePlugin: {
		get: async () => {
			throw new Error("Item with given key does not exist");
		},
		set: async () => ({ value: true }),
		remove: async () => ({ value: true }),
	},
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({}) }));

const CODE = "A".repeat(20) + "b-_9".repeat(5); // 40 base64url chars

type CallbackMod = typeof import("./AppCallback.js");

/** A fresh AppCallback module (its outcome is module state) on a fake browser URL. */
async function landOn(url: string) {
	vi.resetModules();
	const u = new URL(url, "https://tagalong.averrow.com");
	const location = { pathname: u.pathname, search: u.search, hash: u.hash };
	const replaceState = vi.fn((_s: unknown, _t: string, next: string) => {
		const n = new URL(next, u);
		location.pathname = n.pathname;
		location.search = n.search;
		location.hash = n.hash;
	});
	const pushState = vi.fn();
	vi.stubGlobal("window", {
		location,
		history: { replaceState, pushState },
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	});
	const mod: CallbackMod = await import("./AppCallback.js");
	return { mod, location, replaceState, pushState };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
	vi.unstubAllGlobals();
	delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe("/auth/app-callback in a browser", () => {
	it("strips a code in the query and fragment, renders without it, and never calls the exchange", async () => {
		const { mod, location, replaceState, pushState } = await landOn(
			`/auth/app-callback?code=${CODE}#code=${CODE}`,
		);
		mod.stripAppCallbackParams();
		expect(replaceState).toHaveBeenCalledWith(null, "", "/auth/app-callback");
		expect(pushState).not.toHaveBeenCalled(); // replaced, not a new history entry
		expect(`${location.pathname}${location.search}${location.hash}`).toBe("/auth/app-callback");

		const html = renderToStaticMarkup(createElement(mod.AppCallback));
		expect(html).not.toContain(CODE);
		expect(html).toContain("Budgetrip app");
		// The only link is the home page.
		expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["/"]);
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("strips a fragment-only URL too", async () => {
		const { mod, location } = await landOn(`/auth/app-callback#code=${CODE}`);
		mod.stripAppCallbackParams();
		expect(location.hash).toBe("");
		expect(location.search).toBe("");
	});

	it("does nothing on the bare path (no history write)", async () => {
		const { mod, replaceState } = await landOn("/auth/app-callback");
		mod.stripAppCallbackParams();
		expect(replaceState).not.toHaveBeenCalled();
	});

	it("leaves look-alike paths alone", async () => {
		for (const path of [
			`/auth/app-callback/?code=${CODE}`,
			`/auth/App-Callback?code=${CODE}`,
			`/x/auth/app-callback?code=${CODE}`,
		]) {
			const { mod, replaceState } = await landOn(path);
			mod.stripAppCallbackParams();
			expect(replaceState, path).not.toHaveBeenCalled();
		}
	});

	it("survives a missing history API (strips nothing, throws nothing)", async () => {
		vi.resetModules();
		vi.stubGlobal("window", {
			location: { pathname: "/auth/app-callback", search: `?code=${CODE}`, hash: "" },
		});
		const mod: CallbackMod = await import("./AppCallback.js");
		expect(() => mod.stripAppCallbackParams()).not.toThrow();
	});

	it("an error page shows a fixed reason, never the raw parameter", async () => {
		const raw = '"><img src=x onerror=alert(1)>';
		const { mod } = await landOn(`/auth/app-callback?error=${encodeURIComponent(raw)}`);
		mod.stripAppCallbackParams();
		const html = renderToStaticMarkup(createElement(mod.AppCallback));
		expect(html).toContain("Sign-in didn");
		expect(html).not.toContain("onerror");
		expect(html).not.toContain("<img");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// The API's native error page links here with error=<HttpError code>
	// (apps/api/src/auth/routes.ts nativeErrorPage / completeSignIn). Every
	// code it can send should get a specific reason, not the generic page.
	it("BUG: has a reason for every error code the API's Apple sign-in sends (apple_bad_token, apple_token_failed, apple_keys_failed, account_deleted)", async () => {
		for (const code of [
			"apple_bad_token",
			"apple_token_failed",
			"apple_keys_failed",
			"account_deleted",
		]) {
			const { mod } = await landOn(`/auth/app-callback?error=${code}`);
			mod.stripAppCallbackParams();
			expect(mod.appCallbackOutcome(), code).toEqual({ error: true, code });
		}
	});
});

describe("parseAuthCallback: more edge cases", () => {
	const load = async () => {
		vi.resetModules();
		return import("./native.js");
	};

	it("takes the query code and ignores the fragment and unrelated parameters", async () => {
		const { AUTH_CALLBACK, parseAuthCallback } = await load();
		expect(parseAuthCallback(`${AUTH_CALLBACK}?code=${CODE}#code=other`)).toEqual({
			kind: "code",
			code: CODE,
		});
		expect(parseAuthCallback(`${AUTH_CALLBACK}?state=x&code=${CODE}`)).toEqual({
			kind: "code",
			code: CODE,
		});
		// A code only in the fragment is not a code.
		expect(parseAuthCallback(`${AUTH_CALLBACK}#code=${CODE}`)).toEqual({ kind: "invalid" });
		expect(parseAuthCallback(AUTH_CALLBACK)).toEqual({ kind: "invalid" });
	});

	it("rejects an empty or non-base64url code, and reduces an odd error to unknown", async () => {
		const { AUTH_CALLBACK, parseAuthCallback } = await load();
		for (const q of ["?code=", `?code=${CODE.slice(0, 20)}+${CODE.slice(21)}`, `?code=${CODE}%00`])
			expect(parseAuthCallback(`${AUTH_CALLBACK}${q}`), q).toEqual({ kind: "invalid" });
		expect(parseAuthCallback(`${AUTH_CALLBACK}?error=`)).toEqual({
			kind: "error",
			error: "unknown",
		});
		expect(parseAuthCallback(`${AUTH_CALLBACK}?error=${"a".repeat(65)}`)).toEqual({
			kind: "error",
			error: "unknown",
		});
		expect(parseAuthCallback(`${AUTH_CALLBACK}?error=apple_bad_token`)).toEqual({
			kind: "error",
			error: "apple_bad_token",
		});
	});

	it("rejects encoded or disguised paths and hosts", async () => {
		const { parseAuthCallback } = await load();
		for (const url of [
			`https://tagalong.averrow.com/auth%2Fapp-callback?code=${CODE}`,
			`https://tagalong.averrow.com/auth/app%2Dcallback?code=${CODE}`,
			`https://tagalong.averrow.com./auth/app-callback?code=${CODE}`,
			`https://tagalong.averrow.com/auth/app-callback;x?code=${CODE}`,
			`https://tagalong.averrow.com/auth/app-callback\t?code=${CODE}`,
			`https://tagalong.averrow.com/auth/app-callback%3Fcode=${CODE}`,
			`https://tagalong.averrow.com/auth/APP-CALLBACK?code=${CODE}`,
			`HTTPS://tagalong.averrow.com/auth/app-callback?code=${CODE}`,
			`https:tagalong.averrow.com/auth/app-callback?code=${CODE}`,
			`https://tagalong.averrow.com:443/auth/app-callback?code=${CODE}`,
		])
			expect(parseAuthCallback(url), url).toBeNull();
		expect(parseAuthCallback(undefined as unknown as string)).toBeNull();
		expect(parseAuthCallback(42 as unknown as string)).toBeNull();
	});

	it("in a browser, a callback URL never triggers an exchange", async () => {
		const { AUTH_CALLBACK, handleAuthUrl, isNative } = await load();
		expect(isNative()).toBe(false);
		await handleAuthUrl(`${AUTH_CALLBACK}?code=${CODE}`);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("nativeAfterAccountDeleted: edges", () => {
	it("in a browser: resolves, calls nothing", async () => {
		vi.resetModules();
		const { nativeAfterAccountDeleted, getNativeToken } = await import("./native.js");
		await expect(nativeAfterAccountDeleted()).resolves.toBeUndefined();
		expect(await getNativeToken()).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("in the app with nothing stored: resolves, calls nothing, and is safe to repeat", async () => {
		vi.resetModules();
		(globalThis as { Capacitor?: unknown }).Capacitor = {
			isNativePlatform: () => true,
			getPlatform: () => "ios",
		};
		const { nativeAfterAccountDeleted, getNativeToken } = await import("./native.js");
		await nativeAfterAccountDeleted();
		await nativeAfterAccountDeleted();
		expect(await getNativeToken()).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
