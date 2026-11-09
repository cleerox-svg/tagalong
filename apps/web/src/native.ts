/**
 * The native (Capacitor iOS / Android) side of the web app: sign-in through
 * the system browser with PKCE, the session token in Keychain / Keystore, and
 * push notifications (spec §9 phase 6).
 *
 * The browser PWA never loads a Capacitor plugin: every plugin is imported
 * dynamically inside a native-only path, so it lands in a lazy chunk. Native
 * detection reads the `Capacitor` global the native shell injects before the
 * page loads (the same `Capacitor.isNativePlatform()` @capacitor/core
 * exposes), so detecting the browser costs nothing either.
 *
 * Nothing here is secret: the session token lives only in secure storage and
 * memory, and the PKCE verifier only in memory for the length of one sign-in.
 */
import { isSafeAppPath, NativeAuthExchangeSchema, type DevicePlatform } from "@tagalong/shared";
import type { FirebaseMessagingPlugin } from "@capacitor-firebase/messaging";
import { navigate } from "./router.js";

const API_BASE = __API_BASE__;

// ---------------------------------------------------------------------------
// Platform.
// ---------------------------------------------------------------------------

interface CapacitorGlobal {
	isNativePlatform?: () => boolean;
	getPlatform?: () => string;
}

function capacitor(): CapacitorGlobal | undefined {
	return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True inside the iOS / Android app; false in any browser (including the PWA). */
export function isNative(): boolean {
	try {
		return capacitor()?.isNativePlatform?.() === true;
	} catch {
		return false;
	}
}

/** "ios" | "android" inside the app, null anywhere else. */
export function nativePlatform(): DevicePlatform | null {
	if (!isNative()) return null;
	const p = capacitor()?.getPlatform?.();
	return p === "ios" || p === "android" ? p : null;
}

// ---------------------------------------------------------------------------
// Session token: secure storage (Keychain / Keystore) with an in-memory cache.
// ---------------------------------------------------------------------------

const TOKEN_KEY = "budgetrip.session";

interface StoredToken {
	token: string;
	expires_at: string;
}

/** undefined: not read from storage yet. null: signed out. */
let cached: StoredToken | null | undefined;
let loading: Promise<StoredToken | null> | null = null;

const secureStorage = async () =>
	(await import("capacitor-secure-storage-plugin")).SecureStoragePlugin;

function parseStored(raw: unknown): StoredToken | null {
	if (typeof raw !== "string") return null;
	try {
		const v = JSON.parse(raw) as Partial<StoredToken> | null;
		if (!v || typeof v.token !== "string" || v.token.length === 0) return null;
		if (typeof v.expires_at !== "string") return null;
		return { token: v.token, expires_at: v.expires_at };
	} catch {
		return null;
	}
}

const expired = (t: StoredToken, now = Date.now()) => {
	const at = Date.parse(t.expires_at);
	return Number.isFinite(at) && at <= now;
};

async function loadToken(): Promise<StoredToken | null> {
	try {
		const store = await secureStorage();
		// `get` rejects when the key doesn't exist.
		const { value } = await store.get({ key: TOKEN_KEY });
		return parseStored(value);
	} catch {
		return null;
	}
}

/** The bearer token for API calls, or null when signed out (or not native). */
export async function getNativeToken(): Promise<string | null> {
	if (!isNative()) return null;
	if (cached === undefined) {
		loading ??= loadToken();
		const loaded = await loading;
		loading = null;
		// A set/clear while we were reading wins over what we read.
		if (cached === undefined) cached = loaded;
	}
	if (cached && expired(cached)) {
		await clearNativeToken();
		return null;
	}
	return cached?.token ?? null;
}

export async function setNativeToken(token: string, expiresAt: string): Promise<void> {
	cached = { token, expires_at: expiresAt };
	try {
		const store = await secureStorage();
		await store.set({ key: TOKEN_KEY, value: JSON.stringify(cached) });
	} catch {
		// Still signed in for this run; the next launch asks again.
	}
}

/**
 * Forget the session. With `onlyIf`, only when that is still the current
 * token, so a late 401 for an old token can't sign out a fresh session.
 */
export async function clearNativeToken(onlyIf?: string): Promise<void> {
	if (onlyIf !== undefined && cached && cached.token !== onlyIf) return;
	cached = null;
	try {
		const store = await secureStorage();
		await store.remove({ key: TOKEN_KEY });
	} catch {
		// Nothing stored.
	}
}

/** A JSON POST to the API with the bearer token (native only). */
async function nativePost(path: string, body: unknown): Promise<Response> {
	const headers = new Headers({ "Content-Type": "application/json" });
	const token = await getNativeToken();
	if (token) headers.set("Authorization", `Bearer ${token}`);
	const res = await fetch(`${API_BASE}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		credentials: "omit",
	});
	if (res.status === 401 && token) await clearNativeToken(token);
	return res;
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636).
// ---------------------------------------------------------------------------

export function base64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes → a 43-character base64url verifier. */
export function createVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64url(bytes);
}

/** S256: base64url(SHA-256(ASCII(verifier))), no padding. */
export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// The sign-in callback.
// ---------------------------------------------------------------------------

/**
 * Where the API sends the app after sign-in: an HTTPS link on our own domain,
 * delivered to the app by Android App Links / iOS Universal Links (verified
 * through /.well-known on that domain). No custom URL scheme: any app could
 * claim one and catch the code.
 */
export const AUTH_CALLBACK_ORIGIN = "https://tagalong.averrow.com";
export const AUTH_CALLBACK_PATH = "/auth/app-callback";
export const AUTH_CALLBACK = `${AUTH_CALLBACK_ORIGIN}${AUTH_CALLBACK_PATH}`;

export type AuthCallback =
	| { kind: "code"; code: string }
	| { kind: "error"; error: string }
	/** Our callback URL, but nothing usable in it. */
	| { kind: "invalid" };

const CODE_SCHEMA = NativeAuthExchangeSchema.shape.code;

/**
 * Read an `appUrlOpen` URL. Null when it isn't the sign-in callback at all
 * (another deep link), so the caller leaves it alone.
 */
export function parseAuthCallback(url: string): AuthCallback | null {
	// Exactly our origin and path, character for character: no other scheme,
	// host, port, userinfo, case variant, trailing slash or extra segment.
	if (typeof url !== "string" || !url.startsWith(AUTH_CALLBACK)) return null;
	const rest = url.slice(AUTH_CALLBACK.length);
	if (rest !== "" && rest[0] !== "?" && rest[0] !== "#") return null;
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return null;
	}
	if (
		parsedUrl.origin !== AUTH_CALLBACK_ORIGIN ||
		parsedUrl.pathname !== AUTH_CALLBACK_PATH ||
		parsedUrl.username !== "" ||
		parsedUrl.password !== ""
	)
		return null;
	const params = parsedUrl.searchParams;
	const codes = params.getAll("code");
	const errors = params.getAll("error");
	if (codes.length === 1 && errors.length === 0) {
		const code = CODE_SCHEMA.safeParse(codes[0]);
		return code.success ? { kind: "code", code: code.data } : { kind: "invalid" };
	}
	if (errors.length === 1 && codes.length === 0) {
		const error = errors[0] ?? "";
		return { kind: "error", error: /^[a-z0-9_]{1,64}$/.test(error) ? error : "unknown" };
	}
	return { kind: "invalid" };
}

/** What a failed sign-in tells the person. Never echoes the callback text. */
export function signInErrorMessage(error: string): string {
	if (error === "cancelled") return "Sign-in was cancelled.";
	if (error === "access_denied") return "Sign-in was cancelled or not allowed.";
	return "We couldn't sign you in. Try again.";
}

export class NativeSignInError extends Error {
	constructor(readonly code: string) {
		super(signInErrorMessage(code));
	}
}

interface Pending {
	verifier: string;
	resolve: () => void;
	reject: (err: NativeSignInError) => void;
	cleanup: () => void;
}

/** The sign-in in progress. Callbacks that arrive without one are ignored. */
let pending: Pending | null = null;

/** After the browser closes without a callback, give a racing callback this long. */
const BROWSER_CLOSED_GRACE_MS = 2000;

async function exchange(code: string, verifier: string): Promise<void> {
	const body = NativeAuthExchangeSchema.safeParse({ code, code_verifier: verifier });
	if (!body.success) throw new NativeSignInError("invalid_callback");
	const res = await fetch(`${API_BASE}/auth/native/exchange`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body.data),
		credentials: "omit",
	});
	if (!res.ok) throw new NativeSignInError("exchange_failed");
	const json = (await res.json().catch(() => null)) as {
		token?: unknown;
		expires_at?: unknown;
	} | null;
	if (typeof json?.token !== "string" || json.token.length === 0)
		throw new NativeSignInError("exchange_failed");
	await setNativeToken(json.token, typeof json.expires_at === "string" ? json.expires_at : "");
}

/**
 * Handle an `appUrlOpen` URL. Exported for tests; the listener set up by
 * `nativeSignIn` is the only production caller.
 */
export async function handleAuthUrl(url: string): Promise<void> {
	const parsed = parseAuthCallback(url);
	if (!parsed || !pending) return;
	const p = pending;
	pending = null;
	p.cleanup();
	try {
		if (parsed.kind === "error") throw new NativeSignInError(parsed.error);
		if (parsed.kind === "invalid") throw new NativeSignInError("invalid_callback");
		await exchange(parsed.code, p.verifier);
		p.resolve();
	} catch (err) {
		p.reject(err instanceof NativeSignInError ? err : new NativeSignInError("exchange_failed"));
	}
}

export type SignInProvider = "google" | "apple";

/**
 * Sign in with Google or Apple in the system browser. Resolves once a session token is
 * stored; rejects with a `NativeSignInError` (its message is safe to show).
 * Starting again while one is pending cancels the old one.
 */
export async function nativeSignIn(provider: SignInProvider): Promise<void> {
	if (pending) {
		const old = pending;
		pending = null;
		old.cleanup();
		old.reject(new NativeSignInError("cancelled"));
	}
	const verifier = createVerifier();
	const challenge = await pkceChallenge(verifier);
	const [{ App }, { Browser }] = await Promise.all([
		import("@capacitor/app"),
		import("@capacitor/browser"),
	]);

	return new Promise<void>((resolve, reject) => {
		let closedTimer: ReturnType<typeof setTimeout> | undefined;
		const handles: Array<Promise<{ remove: () => Promise<void> }>> = [];
		const me: Pending = {
			verifier,
			resolve,
			reject,
			cleanup: () => {
				if (closedTimer) clearTimeout(closedTimer);
				for (const h of handles) void h.then((x) => x.remove()).catch(() => undefined);
				// Not supported on Android (the custom tab closes itself); harmless.
				void Browser.close().catch(() => undefined);
			},
		};
		pending = me;
		handles.push(App.addListener("appUrlOpen", (e) => void handleAuthUrl(e.url)));
		handles.push(
			Browser.addListener("browserFinished", () => {
				if (pending !== me) return;
				closedTimer = setTimeout(() => {
					if (pending !== me) return;
					pending = null;
					me.cleanup();
					reject(new NativeSignInError("cancelled"));
				}, BROWSER_CLOSED_GRACE_MS);
			}),
		);
		const start = provider === "apple" ? "/auth/apple/start" : "/auth/google/start";
		const url = `${API_BASE}${start}?native=1&code_challenge=${encodeURIComponent(challenge)}`;
		Browser.open({ url, presentationStyle: "popover" }).catch(() => {
			if (pending !== me) return;
			pending = null;
			me.cleanup();
			reject(new NativeSignInError("browser_failed"));
		});
	});
}

/** For tests: forget any sign-in in progress and every in-memory cache (as on a relaunch). */
export function resetNativeStateForTests(): void {
	pending = null;
	cached = undefined;
	loading = null;
	pushToken = undefined;
	listenersAttached = null;
	messagingPlugin = null;
}

// ---------------------------------------------------------------------------
// Push.
// ---------------------------------------------------------------------------

export type PushPermission = "granted" | "denied" | "prompt" | "unsupported";
/** What enabling push came to. "failed": it should work here, but didn't this time. */
export type PushOutcome = PushPermission | "failed";

let messagingPlugin: FirebaseMessagingPlugin | null = null;

/**
 * The native FirebaseMessaging plugin. Registered straight through
 * @capacitor/core rather than by importing the package: its entry also wires a
 * web implementation that needs the Firebase web SDK, which the PWA
 * deliberately doesn't ship. In the app the native side answers every call.
 */
async function messaging(): Promise<FirebaseMessagingPlugin> {
	if (!messagingPlugin) {
		const { registerPlugin } = await import("@capacitor/core");
		messagingPlugin = registerPlugin<FirebaseMessagingPlugin>("FirebaseMessaging");
	}
	return messagingPlugin;
}

/** Capacitor rejects a call to a plugin the native shell doesn't have with this code. */
const unimplemented = (err: unknown) =>
	(err as { code?: unknown } | null)?.code === "UNIMPLEMENTED";

export class PushRegisterError extends Error {
	constructor(readonly status: number) {
		super(`Device registration failed: HTTP ${status}`);
	}
}

/** Log a push failure without its details (which could carry the device token). */
function warnPush(what: string, err: unknown): void {
	const status = err instanceof PushRegisterError ? ` (HTTP ${err.status})` : "";
	const code = (err as { code?: unknown } | null)?.code;
	console.warn(`Push: ${what} failed${status}${typeof code === "string" ? ` [${code}]` : ""}`);
}

const PUSH_TOKEN_KEY = "budgetrip.push-token";

/**
 * The FCM token we last registered, so sign-out can unregister it, also after
 * a relaunch. undefined: not read from secure storage yet. null: none.
 */
let pushToken: string | null | undefined;
let listenersAttached: Promise<void> | null = null;

async function storedPushToken(): Promise<string | null> {
	if (pushToken !== undefined) return pushToken;
	try {
		const { value } = await (await secureStorage()).get({ key: PUSH_TOKEN_KEY });
		return typeof value === "string" && value ? value : null;
	} catch {
		return null; // `get` rejects when the key doesn't exist.
	}
}

async function rememberPushToken(token: string | null): Promise<void> {
	pushToken = token;
	try {
		const store = await secureStorage();
		if (token) await store.set({ key: PUSH_TOKEN_KEY, value: token });
		else await store.remove({ key: PUSH_TOKEN_KEY });
	} catch {
		// Kept in memory for this run.
	}
}

/** The in-app path a notification tap should open, or null when it isn't safe. */
export function safeTapPath(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const path = (data as { path?: unknown }).path;
	return typeof path === "string" && isSafeAppPath(path) ? path : null;
}

/**
 * Register this device for push with the signed-in account. Resolves false
 * when there's nothing to do (signed out, or not iOS / Android); throws a
 * `PushRegisterError` when the API refuses.
 */
export async function registerDevice(token: string): Promise<boolean> {
	const platform = nativePlatform();
	if (!platform || !(await getNativeToken())) return false;
	const res = await nativePost("/push/devices", { platform, token });
	if (!res.ok) throw new PushRegisterError(res.status);
	await rememberPushToken(token);
	return true;
}

/**
 * Listen for notification taps and token refreshes. Native only; never asks
 * for permission. Safe to call more than once.
 */
export function attachPushListeners(): Promise<void> {
	if (!isNative()) return Promise.resolve();
	listenersAttached ??= (async () => {
		const fm = await messaging();
		await fm.addListener("notificationActionPerformed", (e) => {
			const path = safeTapPath(e.notification?.data);
			if (path) navigate(path);
		});
		await fm.addListener("tokenReceived", (e) => {
			if (typeof e.token === "string" && e.token)
				registerDevice(e.token).catch((err: unknown) => warnPush("token refresh", err));
		});
	})().catch((err: unknown) => {
		listenersAttached = null;
		if (!unimplemented(err)) warnPush("push listeners", err);
	});
	return listenersAttached;
}

/** The OS permission. "unsupported" outside the app or without the plugin. */
export async function pushPermission(): Promise<PushOutcome> {
	if (!nativePlatform()) return "unsupported";
	try {
		const { receive } = await (await messaging()).checkPermissions();
		if (receive === "granted" || receive === "denied") return receive;
		return "prompt";
	} catch (err) {
		if (unimplemented(err)) return "unsupported";
		warnPush("permission check", err);
		return "failed";
	}
}

/**
 * Ask for permission (only if it hasn't been decided) and register this
 * device. Resolves to the permission afterwards, or "failed" when asking,
 * getting a token or registering it went wrong. Never throws.
 */
export async function enablePush(): Promise<PushOutcome> {
	let perm = await pushPermission();
	if (perm === "unsupported" || perm === "failed") return perm;
	try {
		const fm = await messaging();
		if (perm === "prompt") {
			const { receive } = await fm.requestPermissions();
			perm = receive === "granted" ? "granted" : receive === "denied" ? "denied" : "prompt";
		}
		if (perm !== "granted") return perm;
		await attachPushListeners();
		const { token } = await fm.getToken();
		if (!token) throw new Error("no token");
		await registerDevice(token);
		return "granted";
	} catch (err) {
		if (unimplemented(err)) return "unsupported";
		warnPush("enabling push", err);
		return "failed";
	}
}

/**
 * On launch when signed in: listen for taps, and (only if permission was
 * already granted) refresh this device's registration. Never prompts.
 */
export async function syncPush(): Promise<void> {
	if (!isNative()) return;
	await attachPushListeners();
	if ((await pushPermission()) === "granted") await enablePush();
}

const ASKED_KEY = "budgetrip.push-asked";

function askedBefore(): boolean {
	try {
		return globalThis.localStorage?.getItem(ASKED_KEY) === "1";
	} catch {
		return true;
	}
}

function rememberAsked(): void {
	try {
		globalThis.localStorage?.setItem(ASKED_KEY, "1");
	} catch {
		// Not remembering only means we may offer again; the OS still won't re-prompt.
	}
}

/**
 * Whether to offer push in context (after a DM, a connection request or
 * acceptance, saving a trip or turning on a price alert): only inside the
 * app, only while the OS hasn't been asked, and only if the in-app offer
 * wasn't answered before. The caller shows its own explainer first and calls
 * `askForPushInContext` or `declinePushInContext`. Never throws.
 */
export async function shouldOfferPush(): Promise<boolean> {
	if (!isNative() || askedBefore()) return false;
	try {
		return (await pushPermission()) === "prompt";
	} catch {
		return false;
	}
}

/** "Not now" on the in-app offer: don't offer again. */
export function declinePushInContext(): void {
	if (isNative()) rememberAsked();
}

/**
 * "Turn on" on the in-app offer: show the system dialog (if the OS still
 * hasn't been asked) and register this device. Remembers the offer was
 * answered once the system dialog has had its say; a failure before that
 * leaves it to be offered again. Never throws.
 */
export async function askForPushInContext(): Promise<PushOutcome> {
	if (!isNative()) return "unsupported";
	const outcome = await enablePush().catch((): PushOutcome => "failed");
	if (outcome !== "failed" && outcome !== "unsupported") rememberAsked();
	return outcome;
}

/**
 * Sign out in the app: unregister this device (best effort, while the bearer
 * is still attached), end the session, then forget the session token and the
 * push token.
 */
export async function nativeSignOut(): Promise<void> {
	const token = await storedPushToken();
	if (token && (await getNativeToken())) {
		try {
			const res = await nativePost("/push/devices/unregister", { token });
			if (!res.ok) throw new PushRegisterError(res.status);
		} catch (err) {
			warnPush("unregistering this device", err);
		}
	}
	await nativePost("/auth/logout", {}).catch(() => undefined);
	await clearNativeToken();
	await rememberPushToken(null);
}

/**
 * After the account was deleted: forget the session token and the push token,
 * here and in secure storage, and any sign-in in progress. Never calls the
 * API: the server already deleted the session and this device's
 * registration, so unregister / logout would only get a 401.
 */
export async function nativeAfterAccountDeleted(): Promise<void> {
	if (pending) {
		const old = pending;
		pending = null;
		old.cleanup();
		old.reject(new NativeSignInError("cancelled"));
	}
	loading = null;
	await clearNativeToken();
	await rememberPushToken(null);
}
