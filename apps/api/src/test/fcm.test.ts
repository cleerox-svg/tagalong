import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isPushConfigured, sendPush, type PushMessage } from "../providers/fcm.js";
import { json, mockFetch } from "./helpers.js";

const DEVICE_TOKEN = "dEviCe-ToKeN:APA91b-secret-device-token-0123456789";

let pem = "";
let publicKey: CryptoKey;

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	publicKey = pair.publicKey;
	const der = new Uint8Array(
		(await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
	);
	let bin = "";
	for (const b of der) bin += String.fromCharCode(b);
	const lines = btoa(bin).match(/.{1,64}/g) ?? [];
	pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
});

afterEach(() => {
	vi.restoreAllMocks();
});

let seq = 0;
/** A distinct service account per test: the token cache is keyed by the secret. */
function account() {
	const n = ++seq;
	const project = `tagalong-test-${n}`;
	const email = `push-${n}@${project}.iam.gserviceaccount.com`;
	const env = {
		FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
			type: "service_account",
			project_id: project,
			client_email: email,
			private_key: pem,
		}),
	};
	return { project, email, env, accessToken: `ya29.access-${n}` };
}

const message = (over: Partial<PushMessage> = {}): PushMessage => ({
	token: DEVICE_TOKEN,
	title: "Price drop",
	body: "Your trip is cheaper",
	data: { tripId: "trip-1", kind: "price_drop" },
	...over,
});

const fcmError = (status: number, grpc: string, code?: string, msg = "error") =>
	json(
		{
			error: {
				code: status,
				message: msg,
				status: grpc,
				details: code
					? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code }]
					: [],
			},
		},
		status,
	);

const b64urlDecode = (s: string) => {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) =>
		c.charCodeAt(0),
	);
};

/** Mocks Google's token endpoint and FCM. Records the requests. */
function google(
	a: ReturnType<typeof account>,
	send: (init?: RequestInit) => Response | Promise<Response> = () =>
		json({ name: `projects/${a.project}/messages/1` }),
) {
	const tokenBodies: URLSearchParams[] = [];
	const sends: { url: URL; init: RequestInit | undefined }[] = [];
	const m = mockFetch((url, init) => {
		if (url.href === "https://oauth2.googleapis.com/token") {
			tokenBodies.push(new URLSearchParams(String(init?.body)));
			return json({ access_token: a.accessToken, expires_in: 3599, token_type: "Bearer" });
		}
		if (url.hostname === "fcm.googleapis.com") {
			sends.push({ url, init });
			return send(init);
		}
		return undefined;
	});
	return { ...m, tokenBodies, sends };
}

describe("fcm provider", () => {
	it("is disabled with no secret and fetches nothing", async () => {
		const m = mockFetch();
		expect(isPushConfigured({})).toBe(false);
		expect(await sendPush({}, message())).toEqual({ status: "disabled" });
		expect(m.calls).toHaveLength(0);
	});

	it("is disabled, with a logged reason, when the secret is not valid JSON", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const m = mockFetch();
		const env = { FCM_SERVICE_ACCOUNT_JSON: `{"private_key": "${pem.slice(0, 80)}` };
		expect(isPushConfigured(env)).toBe(false);
		expect(await sendPush(env, message())).toEqual({ status: "disabled" });
		expect(m.calls).toHaveLength(0);
		expect(warn).toHaveBeenCalled();
		const logged = warn.mock.calls.flat().map(String).join(" ");
		expect(logged).toContain("not valid JSON");
		expect(logged).not.toContain("PRIVATE KEY");
	});

	it("is disabled when a required field is missing", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const m = mockFetch();
		const env = {
			FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "p", private_key: pem }),
		};
		expect(isPushConfigured(env)).toBe(false);
		expect(await sendPush(env, message())).toEqual({ status: "disabled" });
		expect(m.calls).toHaveLength(0);
	});

	it("exchanges a signed JWT for an access token, then sends the message", async () => {
		const a = account();
		expect(isPushConfigured(a.env)).toBe(true);
		const g = google(a);

		expect(await sendPush(a.env, message())).toEqual({ status: "ok" });

		// Token exchange: JWT bearer grant, RS256, the claims FCM needs, valid signature.
		expect(g.tokenBodies).toHaveLength(1);
		const form = g.tokenBodies[0]!;
		expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
		const [h, c, s] = (form.get("assertion") ?? "").split(".");
		const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h!)));
		const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c!)));
		expect(header).toEqual({ alg: "RS256", typ: "JWT" });
		expect(claims).toMatchObject({
			iss: a.email,
			scope: "https://www.googleapis.com/auth/firebase.messaging",
			aud: "https://oauth2.googleapis.com/token",
		});
		expect(claims.exp - claims.iat).toBe(3600);
		expect(Math.abs(claims.iat - Date.now() / 1000)).toBeLessThan(60);
		const valid = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			publicKey,
			b64urlDecode(s!),
			new TextEncoder().encode(`${h}.${c}`),
		);
		expect(valid).toBe(true);

		// Send: the project's v1 endpoint, bearer token, the full message shape.
		expect(g.sends).toHaveLength(1);
		const send = g.sends[0]!;
		expect(send.url.href).toBe(`https://fcm.googleapis.com/v1/projects/${a.project}/messages:send`);
		expect(send.init?.method).toBe("POST");
		expect(new Headers(send.init?.headers).get("Authorization")).toBe(`Bearer ${a.accessToken}`);
		expect(JSON.parse(String(send.init?.body))).toEqual({
			message: {
				token: DEVICE_TOKEN,
				notification: { title: "Price drop", body: "Your trip is cheaper" },
				data: { tripId: "trip-1", kind: "price_drop" },
				android: { priority: "high" },
				apns: { payload: { aps: { sound: "default" } } },
			},
		});
		expect(send.init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("reuses the cached access token across sends", async () => {
		const a = account();
		const g = google(a);
		expect(await sendPush(a.env, message())).toEqual({ status: "ok" });
		expect(await sendPush(a.env, message({ title: "Second" }))).toEqual({ status: "ok" });
		expect(g.tokenBodies).toHaveLength(1);
		expect(g.sends).toHaveLength(2);
		for (const s of g.sends)
			expect(new Headers(s.init?.headers).get("Authorization")).toBe(`Bearer ${a.accessToken}`);
	});

	it("does not reuse a token minted for a different secret", async () => {
		const a = account();
		const b = account();
		const ga = google(a);
		expect(await sendPush(a.env, message())).toEqual({ status: "ok" });
		ga.spy.mockRestore();
		const gb = google(b);
		expect(await sendPush(b.env, message())).toEqual({ status: "ok" });
		expect(gb.tokenBodies).toHaveLength(1);
		expect(new Headers(gb.sends[0]?.init?.headers).get("Authorization")).toBe(
			`Bearer ${b.accessToken}`,
		);
	});

	it("refreshes the token within a minute of expiry", async () => {
		const a = account();
		const g = google(a);
		const t0 = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(t0);
		expect(await sendPush(a.env, message())).toEqual({ status: "ok" });
		now.mockReturnValue(t0 + 3599_000 - 61_000);
		expect(await sendPush(a.env, message())).toEqual({ status: "ok" });
		expect(g.tokenBodies).toHaveLength(1);
		now.mockReturnValue(t0 + 3599_000 - 59_000);
		expect(await sendPush(a.env, message())).toEqual({ status: "ok" });
		expect(g.tokenBodies).toHaveLength(2);
	});

	it("maps 404 UNREGISTERED to invalid_token", async () => {
		const a = account();
		google(a, () => fcmError(404, "NOT_FOUND", "UNREGISTERED", "Requested entity was not found."));
		const r = await sendPush(a.env, message());
		expect(r.status).toBe("invalid_token");
		expect(r).toMatchObject({ detail: expect.stringContaining("UNREGISTERED") });
	});

	it("maps 400 INVALID_ARGUMENT about the token to invalid_token", async () => {
		const a = account();
		google(a, () =>
			fcmError(
				400,
				"INVALID_ARGUMENT",
				"INVALID_ARGUMENT",
				`The registration token is not a valid FCM registration token: ${DEVICE_TOKEN}`,
			),
		);
		const r = await sendPush(a.env, message());
		expect(r.status).toBe("invalid_token");
		expect(JSON.stringify(r)).not.toContain(DEVICE_TOKEN);
	});

	it("maps 400 INVALID_ARGUMENT about something else to error", async () => {
		const a = account();
		google(a, () =>
			fcmError(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT", "Invalid JSON payload received."),
		);
		expect((await sendPush(a.env, message())).status).toBe("error");
	});

	it("maps 429 to retryable", async () => {
		const a = account();
		google(a, () => fcmError(429, "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"));
		const r = await sendPush(a.env, message());
		expect(r).toEqual({
			status: "retryable",
			detail: "HTTP 429 RESOURCE_EXHAUSTED QUOTA_EXCEEDED",
		});
	});

	it("maps 500 to retryable", async () => {
		const a = account();
		google(a, () => fcmError(500, "INTERNAL", "INTERNAL"));
		expect((await sendPush(a.env, message())).status).toBe("retryable");
	});

	it("maps a network error to retryable", async () => {
		const a = account();
		google(a, () => {
			throw new TypeError("Network connection lost.");
		});
		expect((await sendPush(a.env, message())).status).toBe("retryable");
	});

	it("maps a failed token exchange: 5xx retryable, 400 error", async () => {
		const a = account();
		mockFetch((url) =>
			url.hostname === "oauth2.googleapis.com" ? json({ error: "backend" }, 503) : undefined,
		);
		expect((await sendPush(a.env, message())).status).toBe("retryable");
		vi.restoreAllMocks();
		const b = account();
		mockFetch((url) =>
			url.hostname === "oauth2.googleapis.com"
				? json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400)
				: undefined,
		);
		expect(await sendPush(b.env, message())).toEqual({
			status: "error",
			detail: "token exchange HTTP 400 invalid_grant",
		});
	});

	it("never logs the device token or the private key", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
			vi.spyOn(console, k).mockImplementation(() => {}),
		);
		const outcomes: (() => Response)[] = [
			() => json({}),
			() => fcmError(404, "NOT_FOUND", "UNREGISTERED"),
			() => fcmError(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT", `bad token ${DEVICE_TOKEN}`),
			() => fcmError(429, "RESOURCE_EXHAUSTED"),
			() => fcmError(500, "INTERNAL"),
			() => {
				throw new TypeError("Network connection lost.");
			},
		];
		const results: unknown[] = [];
		for (const send of outcomes) {
			const a = account();
			google(a, send);
			results.push(await sendPush(a.env, message()));
			vi.mocked(fetch).mockRestore();
		}
		// A malformed secret logs its reason; the key must not leak with it.
		results.push(await sendPush({ FCM_SERVICE_ACCOUNT_JSON: `{"private_key":"${pem}` }, message()));

		const keyBody = pem.split("\n")[1]!;
		const text = JSON.stringify([results, spies.map((s) => s.mock.calls)]);
		expect(text).not.toContain(DEVICE_TOKEN);
		expect(text).not.toContain(keyBody);
		expect(text).not.toContain("ya29.");
	});
});
