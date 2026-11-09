import { afterEach, describe, expect, it, vi } from "vitest";
import { signedInAs } from "./account.js";

type Mod = typeof import("./AppCallback.js");

/** A fresh AppCallback module (its captured outcome is module state) on a fake URL. */
async function landOn(url: string) {
	vi.resetModules();
	const u = new URL(url, "https://tagalong.averrow.com");
	const replaceState = vi.fn((_s: unknown, _t: string, next: string) => {
		const n = new URL(next, u);
		location.pathname = n.pathname;
		location.search = n.search;
		location.hash = n.hash;
	});
	const location = { pathname: u.pathname, search: u.search, hash: u.hash };
	vi.stubGlobal("window", { location, history: { replaceState } });
	const mod: Mod = await import("./AppCallback.js");
	return { mod, location, replaceState };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("stripAppCallbackParams error capture", () => {
	it("captures a known error code, with a fixed reason, and strips the URL", async () => {
		const { mod, location, replaceState } = await landOn("/auth/app-callback?error=cancelled");
		mod.stripAppCallbackParams();
		expect(mod.appCallbackOutcome()).toEqual({ error: true, code: "cancelled" });
		expect(mod.appCallbackErrorReason("cancelled")).toBe("Sign-in was cancelled.");
		expect(replaceState).toHaveBeenCalledWith(null, "", "/auth/app-callback");
		expect(location.search).toBe("");
		expect(location.hash).toBe("");
	});

	it("accepts every allowlisted code", async () => {
		for (const code of [
			"cancelled",
			"bad_state",
			"bad_request",
			"misconfigured",
			"rate_limited",
			"internal",
			"google_token_failed",
			"google_bad_token",
			"apple_failed",
		]) {
			const { mod } = await landOn(`/auth/app-callback?error=${code}`);
			mod.stripAppCallbackParams();
			expect(mod.appCallbackOutcome(), code).toEqual({ error: true, code });
			expect(mod.appCallbackErrorReason(code as never), code).toBeTruthy();
		}
	});

	it("maps an unknown code to generic and never keeps the raw value", async () => {
		const raw = "<script>alert(1)</script>";
		const { mod, location } = await landOn(
			`/auth/app-callback?error=${encodeURIComponent(raw)}&error_description=x`,
		);
		mod.stripAppCallbackParams();
		const outcome = mod.appCallbackOutcome();
		expect(outcome).toEqual({ error: true, code: "generic" });
		expect(JSON.stringify(outcome)).not.toContain("script");
		expect(mod.appCallbackErrorReason("generic")).toBeNull();
		expect(location.search).toBe("");
	});

	it("does not treat inherited object keys as known codes", async () => {
		const { mod } = await landOn("/auth/app-callback?error=toString");
		mod.stripAppCallbackParams();
		expect(mod.appCallbackOutcome()).toEqual({ error: true, code: "generic" });
	});

	it("reports success when there is no error param, and still strips the code", async () => {
		const { mod, location, replaceState } = await landOn("/auth/app-callback?code=abc123#x");
		mod.stripAppCallbackParams();
		expect(mod.appCallbackOutcome()).toEqual({ error: false });
		expect(replaceState).toHaveBeenCalledOnce();
		expect(location.search).toBe("");
		expect(location.hash).toBe("");
	});

	it("reads an error from the fragment too", async () => {
		const { mod, location } = await landOn("/auth/app-callback#error=apple_failed");
		mod.stripAppCallbackParams();
		expect(mod.appCallbackOutcome()).toEqual({ error: true, code: "apple_failed" });
		expect(location.hash).toBe("");
	});

	it("keeps the outcome when called again after stripping (idempotent)", async () => {
		const { mod, replaceState } = await landOn("/auth/app-callback?error=bad_state");
		mod.stripAppCallbackParams();
		mod.stripAppCallbackParams();
		expect(replaceState).toHaveBeenCalledOnce();
		expect(mod.appCallbackOutcome()).toEqual({ error: true, code: "bad_state" });
	});

	it("leaves other paths alone", async () => {
		const { mod, replaceState } = await landOn("/trips?error=cancelled");
		mod.stripAppCallbackParams();
		expect(replaceState).not.toHaveBeenCalled();
		expect(mod.appCallbackOutcome()).toEqual({ error: false });
	});
});

describe("signedInAs", () => {
	it("shows the email when there is one", () => {
		expect(
			signedInAs({ email: "a@example.com", display_name: "Ana", sign_in_providers: ["apple"] }),
		).toBe("a@example.com");
	});

	it("falls back to the display name", () => {
		expect(signedInAs({ email: "", display_name: "Ana", sign_in_providers: ["google"] })).toBe(
			"Ana",
		);
		expect(signedInAs({ email: "", display_name: "Ana" })).toBe("Ana");
	});

	it("says the email is hidden for Apple sign-in without an email", () => {
		expect(signedInAs({ email: "", display_name: "Ana", sign_in_providers: ["apple"] })).toBe(
			"Ana (Apple ID, email hidden)",
		);
		expect(signedInAs({ email: "", display_name: "", sign_in_providers: ["apple"] })).toBe(
			"Apple ID, email hidden",
		);
	});
});
