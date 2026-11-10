import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// Read as raw text (Vite `?raw`), like wellknown.test.ts: the test parses
// exactly the bytes Xcode, Gradle and the stores see.
import storeListingRaw from "../../../docs/STORE_LISTING.md?raw";
import capacitorConfigRaw from "../capacitor.config.ts?raw";
import androidManifestRaw from "../android/app/src/main/AndroidManifest.xml?raw";
import appGradleRaw from "../android/app/build.gradle?raw";
import variablesGradleRaw from "../android/variables.gradle?raw";
import entitlementsRaw from "../ios/App/App/App.entitlements?raw";
import appIconContentsRaw from "../ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json?raw";
import infoPlistRaw from "../ios/App/App/Info.plist?raw";
import privacyInfoRaw from "../ios/App/App/PrivacyInfo.xcprivacy?raw";
import pbxprojRaw from "../ios/App/App.xcodeproj/project.pbxproj?raw";
import aasaRaw from "../public/.well-known/apple-app-site-association?raw";
import assetlinksRaw from "../public/.well-known/assetlinks.json?raw";

// Store submission (spec §9 phase 8): the native shells must agree with each
// other, with the verified-link files, and with docs/STORE_LISTING.md.
const APP_ID = "com.averrow.budgetrip";

/** The nine data types docs/STORE_LISTING.md §3 declares (spec §9 phase 8). */
const EXPECTED_DATA_TYPES = [
	"EmailAddress",
	"Name",
	"EmailsOrTextMessages",
	"OtherUserContent",
	"SearchHistory",
	"UserID",
	"DeviceID",
	"CoarseLocation",
	"OtherDataTypes",
].map((t) => `NSPrivacyCollectedDataType${t}`);

// ---------------------------------------------------------------------------
// A minimal XML plist reader: dict, array, string, integer, true, false.
// Enough for Info.plist, entitlements and the privacy manifest; no dependency.

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };
type PlistDict = { [key: string]: PlistValue };

function parsePlist(xml: string): PlistValue {
	const body = xml
		.replace(/<\?xml[^>]*\?>/, "")
		.replace(/<!DOCTYPE[^>]*>/, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	const tokens = [...body.matchAll(/<(\/?)([A-Za-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/g)]
		.map((m) => ({ close: m[1] === "/", tag: m[2], selfClose: m[3] === "/", text: m[4] }))
		.filter((t) => t.tag !== undefined || (t.text ?? "").trim() !== "");
	let i = 0;
	const unescape = (s: string) =>
		s
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&amp;/g, "&");
	const textUntilClose = (tag: string): string => {
		let out = "";
		while (tokens[i] && !(tokens[i]?.close && tokens[i]?.tag === tag))
			out += tokens[i++]?.text ?? "";
		if (!tokens[i]) throw new Error(`unclosed <${tag}>`);
		i++;
		return unescape(out);
	};
	const value = (): PlistValue => {
		const t = tokens[i++];
		if (!t?.tag || t.close) throw new Error(`unexpected plist token at ${i - 1}`);
		switch (t.tag) {
			case "true":
			case "false":
				if (!t.selfClose) textUntilClose(t.tag);
				return t.tag === "true";
			case "string":
				return t.selfClose ? "" : textUntilClose("string");
			case "integer":
				return Number(textUntilClose("integer"));
			case "array": {
				const arr: PlistValue[] = [];
				if (t.selfClose) return arr;
				while (!(tokens[i]?.close && tokens[i]?.tag === "array")) arr.push(value());
				i++;
				return arr;
			}
			case "dict": {
				const d: PlistDict = {};
				if (t.selfClose) return d;
				while (!(tokens[i]?.close && tokens[i]?.tag === "dict")) {
					const k = tokens[i++];
					if (k?.tag !== "key" || k.close) throw new Error("expected <key> in <dict>");
					const key = textUntilClose("key");
					if (Object.hasOwn(d, key)) throw new Error(`duplicate key ${key}`);
					d[key] = value();
				}
				i++;
				return d;
			}
			case "plist": {
				const v = value();
				if (!(tokens[i]?.close && tokens[i]?.tag === "plist")) throw new Error("expected </plist>");
				i++;
				return v;
			}
			default:
				throw new Error(`unsupported plist tag <${t.tag}>`);
		}
	};
	const root = value();
	if (i !== tokens.length) throw new Error("trailing content after </plist>");
	return root;
}

function plistDict(xml: string): PlistDict {
	const v = parsePlist(xml);
	if (typeof v !== "object" || Array.isArray(v)) throw new Error("plist root is not a dict");
	return v;
}

// ---------------------------------------------------------------------------
// project.pbxproj: just enough to walk from the App target to its objects.

/** The body of the object with this id (single- or multi-line), without its braces. */
function pbxObject(id: string): string {
	const start = new RegExp(`^\\t\\t${id}(?: /\\*[^*]*\\*/)? = \\{`, "m").exec(pbxprojRaw);
	if (!start) throw new Error(`pbxproj object ${id} not found`);
	let depth = 0;
	const from = start.index + start[0].length - 1;
	for (let j = from; j < pbxprojRaw.length; j++) {
		const c = pbxprojRaw[j];
		if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return pbxprojRaw.slice(from + 1, j);
	}
	throw new Error(`pbxproj object ${id} unterminated`);
}

/** Ids in a `name = ( id /* … *\/, … );` list. */
function pbxIdList(body: string, name: string): string[] {
	const m = new RegExp(`\\b${name} = \\(([\\s\\S]*?)\\);`).exec(body);
	if (!m?.[1]) throw new Error(`pbxproj list ${name} not found`);
	return [...m[1].matchAll(/([0-9A-F]{24})/g)].map((x) => x[1] as string);
}

function pbxField(body: string, name: string): string | undefined {
	const m = new RegExp(`(?:^|[\\s{;])${name} = ("(?:[^"\\\\]|\\\\.)*"|[^;]+);`).exec(body);
	return m?.[1]?.replace(/^"(.*)"$/, "$1");
}

function appTargetId(): string {
	const m = /^\t\t([0-9A-F]{24}) \/\* App \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/m.exec(
		pbxprojRaw,
	);
	if (!m?.[1]) throw new Error("App PBXNativeTarget not found");
	return m[1];
}

/** The App target's build configurations (Debug and Release), as setting maps. */
function appTargetConfigs(): { name: string; settings: Record<string, string> }[] {
	const target = pbxObject(appTargetId());
	const listId = pbxField(target, "buildConfigurationList")?.match(/[0-9A-F]{24}/)?.[0];
	if (!listId) throw new Error("App target has no buildConfigurationList");
	return pbxIdList(pbxObject(listId), "buildConfigurations").map((id) => {
		const cfg = pbxObject(id);
		const block = /buildSettings = \{([\s\S]*?)\n\t\t\t\};/.exec(cfg)?.[1] ?? "";
		const settings: Record<string, string> = {};
		for (const m of block.matchAll(/^\t\t\t\t([A-Z_]+) = ("(?:[^"\\]|\\.)*"|[^;(]+);$/gm)) {
			settings[m[1] as string] = (m[2] as string).replace(/^"(.*)"$/, "$1");
		}
		return { name: pbxField(cfg, "name") ?? "", settings };
	});
}

// ---------------------------------------------------------------------------
// Gradle: literal values, with rootProject.ext.* resolved from variables.gradle.

function gradleValue(name: string): string {
	const m = new RegExp(`^\\s*${name}\\s*(?:=\\s*)?("[^"]*"|'[^']*'|[\\w.]+)\\s*$`, "m").exec(
		appGradleRaw,
	);
	if (!m?.[1]) throw new Error(`${name} not found in android/app/build.gradle`);
	const raw = m[1];
	const ext = /^rootProject\.ext\.(\w+)$/.exec(raw);
	if (ext?.[1]) {
		const v = new RegExp(`^\\s*${ext[1]}\\s*=\\s*("[^"]*"|'[^']*'|\\w+)\\s*$`, "m").exec(
			variablesGradleRaw,
		);
		if (!v?.[1]) throw new Error(`${ext[1]} not found in android/variables.gradle`);
		return v[1].replace(/^["'](.*)["']$/, "$1");
	}
	return raw.replace(/^["'](.*)["']$/, "$1");
}

// ---------------------------------------------------------------------------

describe("bundle id", () => {
	it("capacitor.config.ts appId", () => {
		expect(/\bappId:\s*"([^"]+)"/.exec(capacitorConfigRaw)?.[1]).toBe(APP_ID);
	});

	it("iOS PRODUCT_BUNDLE_IDENTIFIER in every App target config", () => {
		const configs = appTargetConfigs();
		expect(configs.map((c) => c.name).sort()).toEqual(["Debug", "Release"]);
		for (const c of configs) expect(c.settings.PRODUCT_BUNDLE_IDENTIFIER, c.name).toBe(APP_ID);
	});

	it("Android applicationId and namespace", () => {
		expect(gradleValue("applicationId")).toBe(APP_ID);
		expect(gradleValue("namespace")).toBe(APP_ID);
	});

	it("the AASA app id and assetlinks package", () => {
		const aasa = JSON.parse(aasaRaw) as { applinks: { details: { appIDs: string[] }[] } };
		const ids = aasa.applinks.details.flatMap((d) => d.appIDs);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) expect(id.slice(id.indexOf(".") + 1)).toBe(APP_ID);
		const links = JSON.parse(assetlinksRaw) as { target: { package_name: string } }[];
		expect(links.map((l) => l.target.package_name)).toEqual([APP_ID]);
	});
});

describe("versions", () => {
	it("iOS MARKETING_VERSION equals Android versionName", () => {
		const versionName = gradleValue("versionName");
		expect(versionName).toMatch(/^\d+(\.\d+){0,2}$/);
		for (const c of appTargetConfigs())
			expect(c.settings.MARKETING_VERSION, c.name).toBe(versionName);
	});

	it("iOS CURRENT_PROJECT_VERSION equals Android versionCode, an integer", () => {
		const versionCode = gradleValue("versionCode");
		expect(versionCode).toMatch(/^[1-9]\d*$/);
		for (const c of appTargetConfigs())
			expect(c.settings.CURRENT_PROJECT_VERSION, c.name).toBe(versionCode);
	});
});

describe("iOS target", () => {
	it("is iPhone only (TARGETED_DEVICE_FAMILY = 1) in every App target config", () => {
		for (const c of appTargetConfigs()) expect(c.settings.TARGETED_DEVICE_FAMILY, c.name).toBe("1");
	});
});

describe("PrivacyInfo.xcprivacy", () => {
	it("exists next to Info.plist", () => {
		expect(existsSync(new URL("../ios/App/App/PrivacyInfo.xcprivacy", import.meta.url))).toBe(true);
	});

	it("is a file reference built into the App target's Resources phase", () => {
		const fileRef =
			/^\t\t([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;[^\n]*\bpath = PrivacyInfo\.xcprivacy;/m.exec(
				pbxprojRaw,
			)?.[1];
		expect(fileRef).toBeDefined();
		const buildFile = new RegExp(
			`^\\t\\t([0-9A-F]{24}) /\\* PrivacyInfo\\.xcprivacy in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${fileRef} `,
			"m",
		).exec(pbxprojRaw)?.[1];
		expect(buildFile).toBeDefined();

		const phases = pbxIdList(pbxObject(appTargetId()), "buildPhases").map((id) => ({
			id,
			body: pbxObject(id),
		}));
		const resources = phases.filter((p) => pbxField(p.body, "isa") === "PBXResourcesBuildPhase");
		expect(resources).toHaveLength(1);
		expect(pbxIdList(resources[0]?.body ?? "", "files")).toContain(buildFile);
	});

	const manifest = plistDict(privacyInfoRaw);

	it("declares no tracking and no tracking domains", () => {
		expect(manifest.NSPrivacyTracking).toBe(false);
		expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
	});

	const entries = manifest.NSPrivacyCollectedDataTypes as PlistDict[];

	it("collects exactly the nine declared data types, once each", () => {
		const types = entries.map((e) => e.NSPrivacyCollectedDataType);
		expect(new Set(types).size).toBe(types.length);
		expect([...types].sort()).toEqual([...EXPECTED_DATA_TYPES].sort());
	});

	it("marks every data type linked and not tracking", () => {
		for (const e of entries) {
			const t = String(e.NSPrivacyCollectedDataType);
			expect(e.NSPrivacyCollectedDataTypeLinked, t).toBe(true);
			expect(e.NSPrivacyCollectedDataTypeTracking, t).toBe(false);
			expect(Array.isArray(e.NSPrivacyCollectedDataTypePurposes), t).toBe(true);
			expect((e.NSPrivacyCollectedDataTypePurposes as string[]).length, t).toBeGreaterThan(0);
		}
	});

	it("matches docs/STORE_LISTING.md §3 entry for entry, in the documented order", () => {
		const section = /^## 3\. [^\n]*\n([\s\S]*?)^## 4\. /m.exec(storeListingRaw)?.[1];
		expect(section).toBeDefined();
		const xml = /```xml\n([\s\S]*?)```/.exec(section ?? "")?.[1] ?? "";
		const docTypes = [
			...xml.matchAll(/<key>NSPrivacyCollectedDataType<\/key>\s*<string>([^<]+)<\/string>/g),
		].map((m) => m[1]);
		expect(docTypes.length).toBeGreaterThan(0);
		expect(entries.map((e) => e.NSPrivacyCollectedDataType)).toEqual(docTypes);
		// The doc's entries say the same about linking and tracking as the manifest.
		const docEntries = parsePlist(`<plist><array>${xml}</array></plist>`) as PlistDict[];
		expect(docEntries).toEqual(entries);
	});
});

describe("Info.plist", () => {
	const info = plistDict(infoPlistRaw);

	it("declares no non-exempt encryption", () => {
		expect(info.ITSAppUsesNonExemptEncryption).toBe(false);
	});

	it("requires arm64 and not armv7", () => {
		const caps = info.UIRequiredDeviceCapabilities as string[];
		expect(caps).toContain("arm64");
		expect(caps).not.toContain("armv7");
	});
});

describe("AndroidManifest.xml", () => {
	it("disables backup", () => {
		const app = /<application\b[^>]*>/.exec(androidManifestRaw)?.[0] ?? "";
		expect(app).toContain('android:allowBackup="false"');
	});

	it("asks for exactly INTERNET and POST_NOTIFICATIONS", () => {
		const perms = [
			...androidManifestRaw
				.replace(/<!--[\s\S]*?-->/g, "")
				.matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*\bandroid:name="([^"]+)"/g),
		].map((m) => m[1]);
		expect(perms.sort()).toEqual([
			"android.permission.INTERNET",
			"android.permission.POST_NOTIFICATIONS",
		]);
	});

	it("verifies App Links for the same host as the iOS associated domain", () => {
		const ent = plistDict(entitlementsRaw);
		const domains = (ent["com.apple.developer.associated-domains"] as string[])
			.filter((d) => d.startsWith("applinks:"))
			.map((d) => d.slice("applinks:".length));
		expect(domains).toHaveLength(1);
		const filters = [
			...androidManifestRaw.matchAll(/<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g),
		];
		const verified = filters.filter((f) => /android:autoVerify="true"/.test(f[0]));
		expect(verified).toHaveLength(1);
		const hosts = [...(verified[0]?.[1] ?? "").matchAll(/android:host="([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(hosts).toEqual(domains);
	});
});

describe("Android SDK levels", () => {
	it("targets and compiles against API 35 or newer", () => {
		const target = Number(gradleValue("targetSdkVersion"));
		const compile = Number(gradleValue("compileSdk"));
		expect(Number.isInteger(target)).toBe(true);
		expect(Number.isInteger(compile)).toBe(true);
		expect(target).toBeGreaterThanOrEqual(35);
		expect(compile).toBeGreaterThanOrEqual(35);
		expect(compile).toBeGreaterThanOrEqual(target);
	});
});

describe("App Store icon", () => {
	const contents = JSON.parse(appIconContentsRaw) as {
		images: { size?: string; filename?: string; idiom?: string }[];
	};
	const marketing = contents.images.filter((img) => img.size === "1024x1024");

	it("is named in Contents.json", () => {
		expect(marketing).toHaveLength(1);
		expect(marketing[0]?.filename).toMatch(/\.png$/);
	});

	it("is a 1024x1024 RGB PNG with no alpha channel and no tRNS chunk", () => {
		const png = readFileSync(
			new URL(
				`../ios/App/App/Assets.xcassets/AppIcon.appiconset/${marketing[0]?.filename}`,
				import.meta.url,
			),
		);
		expect(png.subarray(0, 8)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		// The first chunk is IHDR: width, height, bit depth, colour type.
		expect(png.toString("latin1", 12, 16)).toBe("IHDR");
		expect(png.readUInt32BE(16)).toBe(1024);
		expect(png.readUInt32BE(20)).toBe(1024);
		expect(png[25]).toBe(2); // colour type 2: truecolour, no alpha

		const chunks: string[] = [];
		for (let off = 8; off + 8 <= png.length;) {
			const len = png.readUInt32BE(off);
			const type = png.toString("latin1", off + 4, off + 8);
			chunks.push(type);
			off += 12 + len;
			if (type === "IEND") break;
		}
		expect(chunks[0]).toBe("IHDR");
		expect(chunks.at(-1)).toBe("IEND");
		expect(chunks).not.toContain("tRNS");
	});
});
