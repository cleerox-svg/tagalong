import { describe, expect, it } from "vitest";
// Read as raw text (Vite `?raw`) so the test parses exactly the bytes served.
import aasaRaw from "../public/.well-known/apple-app-site-association?raw";
import assetlinksRaw from "../public/.well-known/assetlinks.json?raw";

// Verified-link files for the native sign-in return (spec §9 phase 7):
// https://tagalong.averrow.com/auth/app-callback opens the app, not a browser.
const APP_ID = "com.averrow.budgetrip";
const CALLBACK = "/auth/app-callback";

interface Aasa {
	applinks: {
		details: { appIDs: string[]; components: { "/": string; comment?: string }[] }[];
	};
}

interface AssetLink {
	relation: string[];
	target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
}

describe("apple-app-site-association", () => {
	const aasa = JSON.parse(aasaRaw) as Aasa;

	it("binds the app (Team ID prefixed) to the callback path", () => {
		expect(aasa.applinks.details).toHaveLength(1);
		const [detail] = aasa.applinks.details;
		expect(detail?.appIDs).toHaveLength(1);
		expect(detail?.appIDs[0]).toMatch(new RegExp(`^[A-Z0-9_]+\\.${APP_ID.replace(/\./g, "\\.")}$`));
		expect(detail?.components.map((c) => c["/"])).toEqual([`${CALLBACK}*`]);
	});
});

describe("assetlinks.json", () => {
	const links = JSON.parse(assetlinksRaw) as AssetLink[];

	it("delegates URL handling to the Android app with signing fingerprints", () => {
		expect(links).toHaveLength(1);
		const [link] = links;
		expect(link?.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
		expect(link?.target.namespace).toBe("android_app");
		expect(link?.target.package_name).toBe(APP_ID);
		expect(link?.target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
		for (const fp of link?.target.sha256_cert_fingerprints ?? []) expect(fp).toMatch(/\S/);
	});
});
