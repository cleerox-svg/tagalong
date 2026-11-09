import { describe, expect, it } from "vitest";
import {
	DEFAULT_NOTIFICATION_PREFS,
	isSafeAppPath,
	NativeAuthExchangeSchema,
	NOTIFICATION_KINDS,
	NotificationPrefsSchema,
	NotificationPrefsUpdateSchema,
	RegisterDeviceSchema,
	UnregisterDeviceSchema,
} from "./index.js";

describe("notification kinds and prefs", () => {
	it("lists every kind once", () => {
		expect([...NOTIFICATION_KINDS]).toEqual([
			"dm",
			"group_message",
			"connection_request",
			"connection_accepted",
			"price_drop",
		]);
	});

	it("defaults: everything on except group messages", () => {
		expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
			dm: true,
			group_message: false,
			connection_request: true,
			connection_accepted: true,
			price_drop: true,
		});
		expect(Object.isFrozen(DEFAULT_NOTIFICATION_PREFS)).toBe(true);
		expect(NotificationPrefsSchema.safeParse(DEFAULT_NOTIFICATION_PREFS).success).toBe(true);
	});

	it("has a key for every kind", () => {
		expect(Object.keys(DEFAULT_NOTIFICATION_PREFS).sort()).toEqual([...NOTIFICATION_KINDS].sort());
	});

	it("full prefs: rejects missing keys, non-booleans and unknown keys", () => {
		const { dm: _dm, ...missing } = DEFAULT_NOTIFICATION_PREFS;
		expect(NotificationPrefsSchema.safeParse(missing).success).toBe(false);
		expect(
			NotificationPrefsSchema.safeParse({ ...DEFAULT_NOTIFICATION_PREFS, dm: 1 }).success,
		).toBe(false);
		expect(
			NotificationPrefsSchema.safeParse({ ...DEFAULT_NOTIFICATION_PREFS, email: true }).success,
		).toBe(false);
	});

	it("update: accepts one or more known keys", () => {
		expect(NotificationPrefsUpdateSchema.parse({ group_message: true })).toEqual({
			group_message: true,
		});
		expect(NotificationPrefsUpdateSchema.safeParse({ dm: false, price_drop: false }).success).toBe(
			true,
		);
		expect(NotificationPrefsUpdateSchema.safeParse({ ...DEFAULT_NOTIFICATION_PREFS }).success).toBe(
			true,
		);
	});

	it("update: rejects empty, unknown keys, non-booleans and non-objects", () => {
		expect(NotificationPrefsUpdateSchema.safeParse({}).success).toBe(false);
		expect(NotificationPrefsUpdateSchema.safeParse({ dm: undefined }).success).toBe(false);
		expect(NotificationPrefsUpdateSchema.safeParse({ dm: true, email: true }).success).toBe(false);
		expect(NotificationPrefsUpdateSchema.safeParse({ email: true }).success).toBe(false);
		expect(NotificationPrefsUpdateSchema.safeParse({ dm: "true" }).success).toBe(false);
		expect(NotificationPrefsUpdateSchema.safeParse({ dm: null }).success).toBe(false);
		expect(NotificationPrefsUpdateSchema.safeParse(null).success).toBe(false);
		expect(NotificationPrefsUpdateSchema.safeParse([]).success).toBe(false);
	});
});

describe("device registration", () => {
	it("accepts ios and android with a trimmed token", () => {
		expect(RegisterDeviceSchema.parse({ platform: "ios", token: "abc123" })).toEqual({
			platform: "ios",
			token: "abc123",
		});
		expect(RegisterDeviceSchema.parse({ platform: "android", token: "  fcm:tok_en-1  " })).toEqual({
			platform: "android",
			token: "fcm:tok_en-1",
		});
	});

	it("token length: 1 and 4096 ok, empty / blank / 4097 rejected", () => {
		expect(RegisterDeviceSchema.safeParse({ platform: "ios", token: "a" }).success).toBe(true);
		expect(
			RegisterDeviceSchema.safeParse({ platform: "ios", token: "a".repeat(4096) }).success,
		).toBe(true);
		expect(
			RegisterDeviceSchema.safeParse({ platform: "ios", token: "a".repeat(4097) }).success,
		).toBe(false);
		expect(RegisterDeviceSchema.safeParse({ platform: "ios", token: "" }).success).toBe(false);
		expect(RegisterDeviceSchema.safeParse({ platform: "ios", token: "   " }).success).toBe(false);
	});

	it("token: rejects inner whitespace and control characters", () => {
		for (const token of ["a b", "a\tb", "a\nb", "a\u0000b", "a\u007Fb", "a\u0085b", "a b"]) {
			expect(RegisterDeviceSchema.safeParse({ platform: "ios", token }).success, token).toBe(false);
			expect(UnregisterDeviceSchema.safeParse({ token }).success, token).toBe(false);
		}
	});

	it("rejects a bad or missing platform, a non-string token and unknown keys", () => {
		expect(RegisterDeviceSchema.safeParse({ platform: "web", token: "x" }).success).toBe(false);
		expect(RegisterDeviceSchema.safeParse({ platform: "IOS", token: "x" }).success).toBe(false);
		expect(RegisterDeviceSchema.safeParse({ token: "x" }).success).toBe(false);
		expect(RegisterDeviceSchema.safeParse({ platform: "ios", token: 123 }).success).toBe(false);
		expect(
			RegisterDeviceSchema.safeParse({ platform: "ios", token: "x", user_id: "u1" }).success,
		).toBe(false);
	});

	it("unregister: token only, same rules", () => {
		expect(UnregisterDeviceSchema.parse({ token: " tok " })).toEqual({ token: "tok" });
		expect(UnregisterDeviceSchema.safeParse({ token: "" }).success).toBe(false);
		expect(UnregisterDeviceSchema.safeParse({ token: "a".repeat(4097) }).success).toBe(false);
		expect(UnregisterDeviceSchema.safeParse({ token: "x", platform: "ios" }).success).toBe(false);
		expect(UnregisterDeviceSchema.safeParse({}).success).toBe(false);
	});
});

describe("NativeAuthExchangeSchema", () => {
	const code = "A".repeat(32);
	const verifier = "a".repeat(43);

	it("accepts the boundary lengths", () => {
		for (const c of [code, "a".repeat(128), "Ab0_-".repeat(8)]) {
			for (const v of [verifier, "Z".repeat(128), `${"x".repeat(39)}-._~`]) {
				expect(NativeAuthExchangeSchema.safeParse({ code: c, code_verifier: v }).success).toBe(
					true,
				);
			}
		}
	});

	it("code: rejects wrong length and non-base64url characters", () => {
		for (const c of [
			"A".repeat(31),
			"A".repeat(129),
			"",
			`${"A".repeat(31)}+`,
			`${"A".repeat(31)}/`,
			`${"A".repeat(31)}=`,
			`${"A".repeat(31)}.`,
			` ${code}`,
		]) {
			expect(
				NativeAuthExchangeSchema.safeParse({ code: c, code_verifier: verifier }).success,
				c,
			).toBe(false);
		}
	});

	it("code_verifier: rejects wrong length and characters outside RFC 7636", () => {
		for (const v of [
			"a".repeat(42),
			"a".repeat(129),
			"",
			`${"a".repeat(42)}+`,
			`${"a".repeat(42)}/`,
			`${"a".repeat(42)}=`,
			`${"a".repeat(42)} `,
			`${"a".repeat(42)}é`,
			`${"a".repeat(42)}\n`,
		]) {
			expect(NativeAuthExchangeSchema.safeParse({ code, code_verifier: v }).success, v).toBe(false);
		}
	});

	it("rejects missing fields and unknown keys", () => {
		expect(NativeAuthExchangeSchema.safeParse({ code }).success).toBe(false);
		expect(NativeAuthExchangeSchema.safeParse({ code_verifier: verifier }).success).toBe(false);
		expect(
			NativeAuthExchangeSchema.safeParse({ code, code_verifier: verifier, state: "x" }).success,
		).toBe(false);
	});
});

describe("isSafeAppPath", () => {
	it.each([
		"/",
		"/chat/dm/abc",
		"/chat/group/g_1?tab=members",
		"/trips/123#prices",
		"/a/b:c",
		"/search?q=a%20b",
		`/${"a".repeat(511)}`,
	])("accepts %j", (p) => {
		expect(isSafeAppPath(p)).toBe(true);
	});

	it.each([
		"",
		"chat",
		"chat/dm",
		"//evil.com",
		"///evil.com",
		"/\\evil",
		"\\\\evil",
		"/chat\\x",
		"https://x",
		"/redirect?to=https://evil.com",
		"javascript:alert(1)",
		"data:text/html,x",
		"/a b",
		"/x\n",
		"/x\r",
		"/x\t",
		"/x\u0000",
		"/x\u007F",
		"/x ",
		" /chat",
		`/${"a".repeat(512)}`,
	])("rejects %j", (p) => {
		expect(isSafeAppPath(p)).toBe(false);
	});
});
