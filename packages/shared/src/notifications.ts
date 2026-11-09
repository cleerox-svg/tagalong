import { z } from "zod";

/** What a push notification is about. One preference toggle per kind. */
export const NOTIFICATION_KINDS = [
	"dm",
	"group_message",
	"connection_request",
	"connection_accepted",
	"price_drop",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);

/** A user's push preferences: one boolean per kind, all present. */
export const NotificationPrefsSchema = z.strictObject({
	dm: z.boolean(),
	group_message: z.boolean(),
	connection_request: z.boolean(),
	connection_accepted: z.boolean(),
	price_drop: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** Group chats are noisy, so they start off; everything else starts on. */
export const DEFAULT_NOTIFICATION_PREFS: Readonly<NotificationPrefs> = Object.freeze({
	dm: true,
	group_message: false,
	connection_request: true,
	connection_accepted: true,
	price_drop: true,
});

/** POST body: change one or more toggles. Unknown keys and an empty body are rejected. */
export const NotificationPrefsUpdateSchema = NotificationPrefsSchema.partial()
	.strict()
	.refine((u) => Object.values(u).some((v) => v !== undefined), "At least one preference");
export type NotificationPrefsUpdate = z.infer<typeof NotificationPrefsUpdateSchema>;

export const DEVICE_PLATFORMS = ["ios", "android"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** No whitespace and no control characters (C0, DEL, C1) anywhere. */
const NO_SPACE_OR_CONTROL_RE = /^[^\s\p{Cc}]+$/u;

/** An APNs / FCM device token: trimmed, 1..4096 chars, no whitespace or control chars. */
export const DeviceTokenSchema = z
	.string()
	.trim()
	.min(1)
	.max(4096)
	.regex(NO_SPACE_OR_CONTROL_RE, "No whitespace or control characters");

export const RegisterDeviceSchema = z.strictObject({
	platform: z.enum(DEVICE_PLATFORMS),
	token: DeviceTokenSchema,
});
export type RegisterDevice = z.infer<typeof RegisterDeviceSchema>;

export const UnregisterDeviceSchema = z.strictObject({
	token: DeviceTokenSchema,
});
export type UnregisterDevice = z.infer<typeof UnregisterDeviceSchema>;

/** RFC 7636 §4.1: 43..128 unreserved characters. */
export const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Native sign-in: swap a one-time code (base64url) plus the PKCE verifier for a session. */
export const NativeAuthExchangeSchema = z.strictObject({
	code: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, "base64url, 32..128 chars"),
	code_verifier: z.string().regex(PKCE_VERIFIER_RE, "RFC 7636 code_verifier"),
});
export type NativeAuthExchange = z.infer<typeof NativeAuthExchangeSchema>;

/** What a push carries. `path` is an in-app route; check it with `isSafeAppPath`. */
export type PushPayload = {
	kind: NotificationKind;
	title: string;
	body: string;
	path: string;
};

export const MAX_APP_PATH_LENGTH = 512;

/**
 * True only for an in-app path such as `/chat/dm/abc`: starts with a single
 * `/`, no backslashes, no scheme, no whitespace or control characters, and at
 * most 512 chars. Anything else (protocol-relative `//host`, `/\host`,
 * `https://…`, `javascript:…`, relative paths) is rejected.
 */
export function isSafeAppPath(path: string): boolean {
	if (typeof path !== "string") return false;
	if (path.length === 0 || path.length > MAX_APP_PATH_LENGTH) return false;
	if (path[0] !== "/") return false;
	if (path[1] === "/") return false;
	if (path.includes("\\")) return false;
	if (path.includes("://")) return false;
	const firstSlash = path.indexOf("/");
	const firstColon = path.indexOf(":");
	if (firstColon !== -1 && firstColon < firstSlash) return false;
	return NO_SPACE_OR_CONTROL_RE.test(path);
}
