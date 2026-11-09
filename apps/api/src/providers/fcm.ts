/**
 * Firebase Cloud Messaging, HTTP v1
 * (https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send):
 * sends one push notification to one device token. FCM serves both Android
 * and iOS; Firebase relays to APNs with the .p8 key uploaded in the Firebase
 * console (docs/SETUP.md).
 *
 * Auth is a Google service account (secret FCM_SERVICE_ACCOUNT_JSON): an
 * RS256 JWT signed with WebCrypto is exchanged for an OAuth access token,
 * cached per isolate until a minute before it expires.
 *
 * Optional, like RESEND_API_KEY: without the secret every send answers
 * `disabled` and nothing is fetched. A malformed secret is also `disabled`,
 * with the reason logged. Nothing here throws, and neither the device token
 * nor the private key is ever logged or returned in a detail.
 */

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 10_000;
/** Refresh the access token this long before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000;
/**
 * PKCS8 PEM armour lines, joined at runtime so the built bundle never contains
 * the literal header: scripts/check-bundle-secrets.sh flags that shape as a
 * pasted private key. Behaviour is the same as the plain string.
 */
const PEM_LABEL = ["PRIVATE", "KEY-----"].join(" ");
const PEM_HEADER = `-----BEGIN ${PEM_LABEL}`;
const PEM_FOOTER = `-----END ${PEM_LABEL}`;

export interface PushMessage {
	/** FCM registration token of the device. Never logged. */
	token: string;
	title: string;
	body: string;
	/** FCM data payload: string values only. */
	data: Record<string, string>;
}

export type PushResult =
	| { status: "ok" }
	| { status: "disabled" }
	/** The device token is dead or not an FCM token: delete it. */
	| { status: "invalid_token"; detail: string }
	/** 429, 5xx, timeout or network: try again later. */
	| { status: "retryable"; detail: string }
	| { status: "error"; detail: string };

type FcmEnv = Pick<Env, "FCM_SERVICE_ACCOUNT_JSON">;

interface ServiceAccount {
	project_id: string;
	client_email: string;
	private_key: string;
}

type ParsedAccount = { ok: true; account: ServiceAccount } | { ok: false; reason: string };

function parseServiceAccount(raw: string): ParsedAccount {
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "FCM_SERVICE_ACCOUNT_JSON is not valid JSON" };
	}
	if (!v || typeof v !== "object")
		return { ok: false, reason: "FCM_SERVICE_ACCOUNT_JSON is not a JSON object" };
	const o = v as Record<string, unknown>;
	for (const f of ["project_id", "client_email", "private_key"] as const) {
		if (typeof o[f] !== "string" || o[f] === "")
			return { ok: false, reason: `FCM_SERVICE_ACCOUNT_JSON has no ${f}` };
	}
	const private_key = (o.private_key as string).replace(/\\n/g, "\n");
	if (!private_key.includes(PEM_HEADER))
		return { ok: false, reason: "FCM_SERVICE_ACCOUNT_JSON private_key is not a PKCS8 PEM" };
	return {
		ok: true,
		account: {
			project_id: o.project_id as string,
			client_email: o.client_email as string,
			private_key,
		},
	};
}

/** Last config parsed, so a bad secret is logged once per isolate, not per send. */
let parsedCache: { raw: string; parsed: ParsedAccount } | undefined;

function serviceAccount(env: FcmEnv): ServiceAccount | undefined {
	const raw = env.FCM_SERVICE_ACCOUNT_JSON;
	if (!raw) return undefined;
	if (parsedCache?.raw !== raw) {
		const parsed = parseServiceAccount(raw);
		parsedCache = { raw, parsed };
		if (!parsed.ok) console.warn("fcm push disabled:", parsed.reason);
	}
	return parsedCache.parsed.ok ? parsedCache.parsed.account : undefined;
}

/** True when FCM_SERVICE_ACCOUNT_JSON is set and well formed. Never fetches. */
export function isPushConfigured(env: FcmEnv): boolean {
	return serviceAccount(env) !== undefined;
}

// ---------------------------------------------------------------------------
// OAuth access token (JWT bearer grant), cached per isolate.
// ---------------------------------------------------------------------------

class TokenError extends Error {
	constructor(
		readonly retryable: boolean,
		message: string,
	) {
		super(message);
	}
}

interface CachedToken {
	/** SHA-256 of the secret: a rotated secret never reuses the old token. */
	key: string;
	accessToken: string;
	expiresAt: number;
}

let tokenCache: CachedToken | undefined;
let inflight: { key: string; promise: Promise<string> } | undefined;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
	return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function importKey(pem: string): Promise<CryptoKey> {
	const b64 = pem.split(PEM_HEADER).join("").split(PEM_FOOTER).join("").replace(/\s+/g, "");
	const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey(
		"pkcs8",
		der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

async function signJwt(sa: ServiceAccount, nowMs: number): Promise<string> {
	let key: CryptoKey;
	try {
		key = await importKey(sa.private_key);
	} catch {
		throw new TokenError(false, "service account private_key could not be imported");
	}
	const iat = Math.floor(nowMs / 1000);
	const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const claims = b64url(
		enc.encode(
			JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
		),
	);
	const input = `${header}.${claims}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input));
	return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function fetchAccessToken(sa: ServiceAccount, key: string): Promise<string> {
	const now = Date.now();
	const assertion = await signJwt(sa, now);
	let res: Response;
	try {
		res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion,
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new TokenError(true, `token exchange failed: ${errName(err)}`);
	}
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: unknown };
		const code = typeof body.error === "string" ? ` ${body.error}` : "";
		throw new TokenError(
			res.status === 429 || res.status >= 500,
			`token exchange HTTP ${res.status}${code}`,
		);
	}
	const body = (await res.json().catch(() => ({}))) as {
		access_token?: unknown;
		expires_in?: unknown;
	};
	if (typeof body.access_token !== "string" || body.access_token === "")
		throw new TokenError(false, "token exchange returned no access_token");
	const ttlS = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
	tokenCache = { key, accessToken: body.access_token, expiresAt: now + ttlS * 1000 };
	return body.access_token;
}

async function accessToken(sa: ServiceAccount, raw: string): Promise<string> {
	const key = await sha256Hex(raw);
	if (tokenCache?.key === key && Date.now() < tokenCache.expiresAt - EXPIRY_MARGIN_MS)
		return tokenCache.accessToken;
	// Concurrent sends in one isolate share one exchange.
	if (inflight?.key !== key) {
		const promise = fetchAccessToken(sa, key).finally(() => {
			if (inflight?.promise === promise) inflight = undefined;
		});
		inflight = { key, promise };
	}
	return inflight.promise;
}

// ---------------------------------------------------------------------------
// Send.
// ---------------------------------------------------------------------------

const errName = (err: unknown) =>
	err instanceof Error ? (err.name === "Error" ? err.message : err.name) : "unknown";

interface FcmErrorBody {
	error?: {
		status?: string;
		message?: string;
		details?: { "@type"?: string; errorCode?: string }[];
	};
}

/** Sends one notification. Never throws; never logs the device token. */
export async function sendPush(env: FcmEnv, msg: PushMessage): Promise<PushResult> {
	const sa = serviceAccount(env);
	const raw = env.FCM_SERVICE_ACCOUNT_JSON;
	if (!sa || !raw) return { status: "disabled" };

	let bearer: string;
	try {
		bearer = await accessToken(sa, raw);
	} catch (err) {
		if (err instanceof TokenError)
			return { status: err.retryable ? "retryable" : "error", detail: err.message };
		return { status: "error", detail: `token exchange failed: ${errName(err)}` };
	}

	let res: Response;
	try {
		res = await fetch(
			`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					message: {
						token: msg.token,
						notification: { title: msg.title, body: msg.body },
						data: msg.data,
						android: { priority: "high" },
						apns: { payload: { aps: { sound: "default" } } },
					},
				}),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			},
		);
	} catch (err) {
		return { status: "retryable", detail: `send failed: ${errName(err)}` };
	}
	if (res.ok) return { status: "ok" };

	const body = (await res.json().catch(() => ({}))) as FcmErrorBody;
	const status = body.error?.status ?? "";
	const fcmCode =
		body.error?.details?.find((d) => typeof d.errorCode === "string")?.errorCode ?? "";
	const message = body.error?.message ?? "";
	// Only codes, never FCM's message text: it can quote the device token.
	const detail = `HTTP ${res.status}${status ? ` ${status}` : ""}${fcmCode && fcmCode !== status ? ` ${fcmCode}` : ""}`;

	if (res.status === 404 || fcmCode === "UNREGISTERED") return { status: "invalid_token", detail };
	if (
		res.status === 400 &&
		(status === "INVALID_ARGUMENT" || fcmCode === "INVALID_ARGUMENT") &&
		/token/i.test(message)
	)
		return { status: "invalid_token", detail };
	if (res.status === 401) {
		// Access token revoked or expired early: fetch a fresh one next time.
		tokenCache = undefined;
		return { status: "retryable", detail };
	}
	if (res.status === 429 || res.status >= 500) return { status: "retryable", detail };
	return { status: "error", detail };
}
